import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join} from 'node:path'

import {git, isRepository} from './git.ts'
import type {GoldenSuite} from './goldens.ts'
import {loadSuite} from './goldens.ts'
import type {AgentGraph, Finding, GraphNode} from './model.ts'
import {runScan, TOOL} from './scan.ts'
import type {PreviewSession} from './session.ts'
import {listSessions} from './session.ts'
import type {Stamp, VerifyResult} from './stamp.ts'
import {runVerify, stampPath} from './stamp.ts'
import type {AgentTravel, TravelResult} from './travel.ts'

/**
 * The passport, as a page: one self-contained HTML file (no scripts, no network, no external fonts) that a reviewer,
 * release manager or judge can open from the story's branch. Every value is read from the same files the gate uses.
 */

export type StampSummary = {environment: string; stamp: Stamp; valid: boolean; why: string}

export type AgentReport = {
  agent: string
  /** Sessions referenced by the main stamp that exist in this checkout, by id. */
  evidence: Record<string, PreviewSession>
  findings: Finding[]
  graph: AgentGraph
  /** Golden conversations as written, when the goldens file exists. */
  suite?: GoldenSuite
  stamps: StampSummary[]
  travel?: AgentTravel
  verify: VerifyResult
}

export type ReportData = {
  agents: AgentReport[]
  commit?: string
  branch?: string
  environment: string
  generatedAt: string
  travelTarget?: string
  tool: string
  valid: boolean
}

export type ReportOptions = {
  agent?: string
  environment: string
  now?: Date
  travel?: TravelResult
  travelFile?: string
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function stampsFor(projectRoot: string, agent: string, environment: string): StampSummary[] {
  const dir = join(projectRoot, 'passport', 'stamps')
  const envs = existsSync(dir) ? readdirSync(dir, {withFileTypes: true}).filter((e) => e.isDirectory()).map((e) => e.name) : []
  const summaries: StampSummary[] = []
  for (const env of envs) {
    const stamp = readJson<Stamp>(join(projectRoot, stampPath(env, agent)))
    if (!stamp) continue
    const check = runVerify(projectRoot, {agent, environment: stamp.environment})[0]?.checks.find((c) => c.name === 'stamp')
    summaries.push({environment: stamp.environment, stamp, valid: Boolean(check?.passed), why: check?.detail ?? ''})
  }
  // The environment the report is for first, then the others in pipeline-ish (alphabetical) order.
  return summaries.sort((a, b) => Number(b.environment === environment) - Number(a.environment === environment) || a.environment.localeCompare(b.environment))
}

export function buildReport(projectRoot: string, options: ReportOptions): ReportData {
  const scan = runScan(projectRoot, {agent: options.agent})
  const verify = runVerify(projectRoot, {agent: options.agent, environment: options.environment, travel: options.travel, travelFile: options.travelFile})
  const savedTravel = options.travelFile ? readJson<TravelResult>(isAbsolute(options.travelFile) ? options.travelFile : join(projectRoot, options.travelFile)) : undefined
  const travel = options.travel ?? savedTravel
  const agents: AgentReport[] = scan.agents.map((graph) => {
    let suite: GoldenSuite | undefined
    try {
      suite = loadSuite(projectRoot, graph.agent).suite
    } catch {
      suite = undefined
    }
    const stamps = stampsFor(projectRoot, graph.agent, options.environment)
    const main = stamps.find((s) => s.environment === options.environment)?.stamp
    const wanted = new Set(main?.goldens.flatMap((g) => g.runs.map((r) => r.sessionId)) ?? [])
    const evidence: Record<string, PreviewSession> = {}
    if (wanted.size > 0) for (const s of listSessions(projectRoot, suite?.bundle ?? graph.agent)) if (wanted.has(s.sessionId)) evidence[s.sessionId] = s
    return {
      agent: graph.agent,
      evidence,
      findings: scan.findings.filter((f) => f.agent === graph.agent),
      graph,
      stamps,
      suite,
      travel: travel?.agents.find((a) => a.agent === graph.agent),
      verify: verify.find((v) => v.agent === graph.agent)!,
    }
  })
  let branch: string | undefined
  let commit: string | undefined
  if (isRepository(projectRoot)) {
    try {
      branch = git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
      commit = git(projectRoot, ['rev-parse', '--short', 'HEAD']).trim()
    } catch {
      // a repository without commits yet
    }
  }
  return {
    agents,
    branch,
    commit,
    environment: options.environment,
    generatedAt: (options.now ?? new Date()).toISOString(),
    tool: TOOL,
    travelTarget: travel?.target.environment ?? travel?.target.branch,
    valid: agents.length > 0 && agents.every((a) => a.verify.passed),
  }
}

// ---------------------------------------------------------------- rendering

/** Escape for HTML text and attribute values. Everything that comes from an agent, a chat or a file goes through this. */
export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({'"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;'})[c]!)

const badge = (ok: boolean, yes = 'pass', no = 'fail') => `<span class="badge ${ok ? 'ok' : 'bad'}">${ok ? yes : no}</span>`
const pct = (n: number) => `${Math.round(n * 100)}%`
const day = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')
const short = (hash: string) => esc(hash.replace(/^sha256:/, '').slice(0, 12))

const STATUS_TEXT: Record<string, string> = {gap: 'will not arrive', 'in-story': 'in this story', 'on-target': 'already there', platform: 'platform'}
const SEVERITY_ORDER: Record<string, number> = {error: 0, info: 2, warn: 1}
const TREE_EDGES = new Set(['defined-by', 'has-subagent', 'has-topic', 'has-version', 'uses-planner', 'defines-action', 'has-action', 'invokes', 'uses-data', 'runs-as'])

function nodeLabel(graph: AgentGraph, node: GraphNode): string {
  const name = node.type === 'Subagent' || node.type === 'AgentAction' ? node.name.replace(`${graph.agent}.`, '').split('.').at(-1)! : node.name
  const status = node.status === 'present' ? '' : ` <span class="tag ${node.status === 'missing' ? 'bad' : 'muted'}">${esc(node.status)}</span>`
  return `<span class="type">${esc(node.type)}</span> ${esc(name)}${status}`
}

function dependencyTree(graph: AgentGraph): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const children = (id: string) => graph.edges.filter((e) => e.from === id && TREE_EDGES.has(e.kind)).map((e) => e.to)
  const routes = (id: string) => graph.edges.filter((e) => e.from === id && e.kind === 'transitions-to').map((e) => byId.get(e.to)?.name.split('.').at(-1) ?? e.to)
  const seen = new Set<string>()
  const render = (id: string): string => {
    const node = byId.get(id)
    if (!node) return `<li>${esc(id)}</li>`
    if (seen.has(id)) return `<li>${nodeLabel(graph, node)} <span class="muted">(shown above)</span></li>`
    seen.add(id)
    const r = routes(id)
    const kids = children(id)
    return `<li>${nodeLabel(graph, node)}${r.length ? ` <span class="muted">→ routes to ${esc(r.join(', '))}</span>` : ''}${kids.length ? `<ul>${kids.map(render).join('')}</ul>` : ''}</li>`
  }
  const root = graph.nodes.find((n) => n.type === 'Agent') ?? graph.nodes[0]
  return root ? `<ul class="tree">${render(root.id)}</ul>` : '<p class="muted">No dependencies found.</p>'
}

function stampCard(s: StampSummary, primary: boolean): string {
  const state = !s.valid ? (s.stamp.verdict === 'stamped' ? 'stale' : 'refused') : 'valid'
  return `<div class="stamp ${state}${primary ? ' primary' : ''}">
  <div class="stamp-env">${esc(s.environment)}</div>
  <div class="stamp-verdict">${state === 'valid' ? 'STAMPED' : state === 'stale' ? 'STALE' : 'REFUSED'}</div>
  <div class="stamp-date">${esc(day(s.stamp.stampedAt))}</div>
  <div class="stamp-meta">${esc(s.stamp.goldens.length)} conversation(s) · ${esc(s.stamp.mode)} actions</div>
</div>`
}

function goldenSection(a: AgentReport, stamp: Stamp | undefined): string {
  if (!stamp) return '<p class="muted">No stamp for this environment yet. Run the golden conversations, then <code>agentia passport stamp</code>.</p>'
  const written = new Map((a.suite?.conversations ?? []).map((c) => [c.id, c]))
  const items = stamp.goldens.map((g) => {
    const golden = written.get(g.id)
    const expect = golden?.turns.map((t, i) => {
      const e = t.expect
      const parts = [e.topic && `routes to <b>${esc(e.topic)}</b>`, e.actionsInclude?.length && `runs <b>${esc(e.actionsInclude.join(', '))}</b>`, e.actionsExclude?.length && `never runs <b>${esc(e.actionsExclude.join(', '))}</b>`, e.replyMatches && `reply matches <code>${esc(e.replyMatches)}</code>`, e.replyNotMatches && `reply never matches <code>${esc(e.replyNotMatches)}</code>`, e.inputsResolved !== false && 'no unfilled merge fields'].filter(Boolean)
      return `<li><span class="muted">Turn ${i + 1}:</span> “${esc(t.utterance ?? '(not written)')}” → ${parts.join('; ')}</li>`
    }).join('') ?? ''
    const runs = g.runs.map((r, i) => {
      const session = a.evidence[r.sessionId]
      const failed = r.checks.filter((c) => !c.passed)
      const scored = golden?.turns.length ?? session?.turns.length ?? 0
      const transcript = session ? session.turns.map((t, ti) => `<div class="turn${ti < scored ? '' : ' extra'}">${ti < scored ? '' : '<div class="muted small">Not part of this golden conversation (not scored)</div>'}<div class="said"><span class="who">Customer</span> ${esc(t.utterance)}</div><div class="said agent"><span class="who">Agent</span> ${esc(t.reply ?? '(no reply)')}</div><div class="muted small">route: ${esc([...t.transitions, t.topic].filter(Boolean).join(' → ') || 'unknown')} · actions: ${esc(t.actions.map((x) => x.name).join(', ') || 'none')}</div></div>`).join('') : `<p class="muted small">Session ${esc(r.sessionId)} is not in this checkout (preview sessions stay on the machine that ran them).</p>`
      return `<details class="run"${r.passed ? '' : ' open'}><summary>${badge(r.passed)} Run ${i + 1} <span class="muted small">${esc(r.startTime ? day(r.startTime) : '')} · ${esc(r.mode ?? '')}</span>${failed[0] ? ` <span class="why">${esc(failed[0].detail)}</span>` : ''}</summary>
<ul class="checks">${r.checks.map((c) => `<li>${badge(c.passed)} <b>${esc(c.name)}</b> ${esc(c.detail)}</li>`).join('')}</ul>${transcript}</details>`
    }).join('')
    const regression = g.regression === 'was-passing' ? ' <span class="tag bad">regression: used to pass</span>' : g.regression === 'route-changed' ? ' <span class="tag warn">route differs from baseline</span>' : ''
    return `<div class="golden ${g.passed ? 'ok' : 'bad'}">
  <div class="golden-head">${badge(g.passed)} <b>${esc(g.id)}</b> ${esc(g.criterion ?? golden?.criterion ?? '')}${regression}<span class="rate">${pct(g.passRate)} of ${esc(g.runs.length)}/${esc(g.required)} runs</span></div>
  ${expect ? `<ul class="expect">${expect}</ul>` : ''}
  ${runs}
</div>`
  }).join('')
  const problems = stamp.problems.map((p) => `<li>${esc(p)}</li>`).join('')
  return `${problems ? `<ul class="problems">${problems}</ul>` : ''}${items}`
}

function travelSection(a: AgentReport, target?: string): string {
  if (!a.travel) return '<p class="muted">Not checked for this report. Add <code>--travel-to &lt;environment&gt;</code>.</p>'
  const rows = [...a.travel.items].sort((x, y) => Number(y.status === 'gap') - Number(x.status === 'gap') || x.component.localeCompare(y.component))
  const steps = a.travel.requirements
    .map((r) => `<li><b>${esc(r.proposedStep.name)}</b> <span class="tag muted">${esc(r.proposedStep.type)}, ${esc(r.proposedStep.order)} deployment</span><pre>${esc(r.proposedStep.instructions)}</pre></li>`)
    .join('')
  return `<div class="scroll"><table><thead><tr><th>Component</th><th>Status</th><th>Why</th></tr></thead><tbody>${rows
    .map((i) => `<tr class="${i.status === 'gap' ? 'gap' : ''}"><td>${esc(i.component)}</td><td>${i.status === 'gap' ? '<span class="tag bad">will not arrive</span>' : esc(STATUS_TEXT[i.status] ?? i.status)}${i.uncommittedEdits ? ' <span class="tag warn">uncommitted edits</span>' : ''}</td><td class="muted">${esc(i.reason ?? '')}</td></tr>`)
    .join('')}</tbody></table></div>
${steps ? `<h3>Deployment steps ${esc(target ?? 'the target')} needs</h3><p class="muted small">Metadata cannot carry these. Add them to the user story (the agent-passport skill does this through Agentia MCP).</p><ul class="steps">${steps}</ul>` : ''}`
}

function agentSection(a: AgentReport, data: ReportData): string {
  const main = a.stamps.find((s) => s.environment === data.environment)
  const findings = [...a.findings].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity])
  return `<section class="agent">
<header class="cover ${a.verify.passed ? 'ok' : 'bad'}">
  <div>
    <div class="eyebrow">Agent passport</div>
    <h1>${esc(a.agent)}</h1>
    <div class="muted">${esc(a.graph.model === 'agent-script' ? 'Agent Script' : 'Classic')} agent${a.graph.label ? ` · ${esc(a.graph.label)}` : ''} · ${esc(a.graph.source.path)}</div>
  </div>
  <div class="verdict">${a.verify.passed ? 'VALID' : 'NOT VALID'}<small>for ${esc(data.environment)}</small></div>
</header>
<div class="stamps">${a.stamps.length ? a.stamps.map((s) => stampCard(s, s.environment === data.environment)).join('') : '<p class="muted">No stamps yet.</p>'}</div>

<h2>Gate checks</h2>
<p class="muted small">What <code>agentia passport verify</code> checks before <code>agentia cicd work submit</code> may continue.</p>
<ul class="checks big">${a.verify.checks.map((c) => `<li>${badge(c.passed)} <b>${esc(c.name)}</b> ${esc(c.detail)}</li>`).join('')}</ul>

<h2>Behaviour: golden conversations</h2>
<p class="muted small">Each conversation proves one acceptance criterion, runs ${esc(main?.stamp.goldens[0]?.required ?? a.suite?.runsPerConversation ?? '')} time(s), and must pass ${esc(pct(main?.stamp.passThreshold ?? a.suite?.passThreshold ?? 1))} of runs.</p>
${goldenSection(a, main?.stamp)}

<h2>Travel${data.travelTarget ? ` to ${esc(data.travelTarget)}` : ''}</h2>
${travelSection(a, data.travelTarget)}

<h2>Dependencies</h2>
${dependencyTree(a.graph)}

<h2>Scan findings</h2>
${findings.length ? `<ul class="findings">${findings.map((f) => `<li><span class="tag ${f.severity === 'error' ? 'bad' : f.severity === 'warn' ? 'warn' : 'muted'}">${esc(f.severity)}</span> <b>${esc(f.code)}</b> ${esc(f.message)}<div class="muted small">Fix: ${esc(f.fix)}</div></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}

<h2>Evidence</h2>
<div class="scroll"><table class="evidence"><tbody>
${a.stamps.map((s) => `<tr><td>${esc(s.environment)} stamp</td><td><code>${esc(stampPath(s.environment, a.agent).split('\\').join('/'))}</code> · agent fingerprint <code>${short(s.stamp.fingerprint)}</code> · goldens <code>${short(s.stamp.goldensHash)}</code>${s.valid ? '' : ` · <span class="why">${esc(s.why)}</span>`}</td></tr>`).join('')}
<tr><td>Preview sessions</td><td>${esc(Object.keys(a.evidence).length)} of ${esc(new Set(main?.stamp.goldens.flatMap((g) => g.runs.map((r) => r.sessionId)) ?? []).size)} scored session(s) are in this checkout</td></tr>
</tbody></table></div>
</section>`
}

const CSS = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d2433;--muted:#5d6577;--line:#e3e1da;--ok:#167a4a;--ok-bg:#e3f4ea;--bad:#b42335;--bad-bg:#fbe7e9;--warn:#8a5a00;--warn-bg:#fdf1d6;--accent:#1f3a8a}
@media (prefers-color-scheme:dark){:root{--bg:#14171f;--card:#1c202b;--ink:#e8eaf0;--muted:#9aa2b4;--line:#2c3242;--ok:#5fd39a;--ok-bg:#16301f;--bad:#ff8a96;--bad-bg:#3a1b21;--warn:#f2c46d;--warn-bg:#352a12;--accent:#9db4ff}}
*{box-sizing:border-box}body{overflow-wrap:anywhere;margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}section.agent,.golden{min-width:0}@media (max-width:600px){section.agent{padding:16px}.stamp{min-width:0;flex:1 1 140px}h1{font-size:22px}}
.top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-bottom:16px}
section.agent{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:28px}
.cover>div{min-width:0;overflow-wrap:anywhere}.cover{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding-bottom:18px;border-bottom:2px solid var(--line)}
.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:12px;color:var(--accent);font-weight:700}
h1{margin:4px 0;font-size:28px}h2{font-size:18px;margin:28px 0 8px}h3{font-size:15px;margin:18px 0 6px}
.verdict{font-weight:800;font-size:26px;letter-spacing:.06em;padding:10px 18px;border-radius:10px;text-align:center}
.verdict small{display:block;font-size:12px;font-weight:600;letter-spacing:0}
.cover.ok .verdict{color:var(--ok);background:var(--ok-bg)}.cover.bad .verdict{color:var(--bad);background:var(--bad-bg)}
.stamps{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0 4px}
.stamp{border:3px double currentColor;border-radius:12px;padding:10px 14px;min-width:170px;transform:rotate(-1.5deg)}
.stamp.valid{color:var(--ok)}.stamp.refused{color:var(--bad)}.stamp.stale{color:var(--warn)}.stamp.primary{border-width:5px}
.stamp-env{font-weight:700}.stamp-verdict{font-size:20px;font-weight:800;letter-spacing:.12em}.stamp-date,.stamp-meta{font-size:12px}
.badge{display:inline-block;min-width:38px;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;border-radius:6px;padding:1px 6px}
.badge.ok{color:var(--ok);background:var(--ok-bg)}.badge.bad{color:var(--bad);background:var(--bad-bg)}
.tag{font-size:11px;border-radius:6px;padding:1px 6px;background:var(--line);color:var(--muted)}
.tag.bad{background:var(--bad-bg);color:var(--bad)}.tag.warn{background:var(--warn-bg);color:var(--warn)}
.muted{color:var(--muted)}.small{font-size:12px}.why{color:var(--bad);font-size:13px}
ul{padding-left:20px}ul.checks,ul.findings,ul.steps,ul.problems{list-style:none;padding:0}ul.checks li,ul.findings li,ul.steps li{margin:6px 0}
ul.checks.big li{padding:8px 10px;border:1px solid var(--line);border-radius:8px}
.golden{border:1px solid var(--line);border-left:5px solid var(--ok);border-radius:10px;padding:12px 14px;margin:12px 0}
.golden.bad{border-left-color:var(--bad)}.golden-head{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline}.rate{margin-left:auto;color:var(--muted);font-size:13px}
ul.expect{margin:8px 0;font-size:14px}
details.run{margin:6px 0;border-top:1px dashed var(--line);padding-top:6px}summary{cursor:pointer}
.turn{margin:8px 0 8px 12px;padding-left:10px;border-left:2px solid var(--line)}.said{margin:2px 0}.said.agent{color:var(--muted)}
.who{font-size:11px;font-weight:700;text-transform:uppercase;margin-right:6px;color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:14px}.scroll{overflow-x:auto}td{overflow-wrap:anywhere}.turn.extra{opacity:.7}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr.gap td{background:var(--bad-bg)}pre{white-space:pre-wrap;background:var(--bg);border-radius:8px;padding:8px 10px;font-size:12px;overflow-x:auto}
code{font-size:12px;background:var(--bg);padding:1px 4px;border-radius:4px;word-break:break-all}
ul.tree,ul.tree ul{list-style:none;padding-left:18px;border-left:1px solid var(--line)}ul.tree{padding-left:0;border:0}ul.tree li{margin:3px 0}
.type{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
footer{color:var(--muted);font-size:12px;text-align:center}
@media print{body{background:#fff}section.agent{break-inside:auto;border:0}details{display:block}details>*{display:block}}
`

export function renderReport(data: ReportData): string {
  const title = data.agents.length === 1 ? `${data.agents[0].agent} passport` : 'Agent passports'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${esc(data.tool)}">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="top"><span><b>Agent Passport</b> for Copado Agentia · ${data.valid ? badge(true, 'valid', '') : badge(false, '', 'not valid')} for ${esc(data.environment)}</span><span>${data.branch ? `branch ${esc(data.branch)}${data.commit ? ` @ ${esc(data.commit)}` : ''} · ` : ''}generated ${esc(day(data.generatedAt))}</span></div>
${data.agents.length ? data.agents.map((a) => agentSection(a, data)).join('\n') : '<section class="agent"><p>No agents found in this project.</p></section>'}
<footer>Generated by ${esc(data.tool)} from the files in <code>passport/</code> and the project source. Re-run <code>agentia passport report</code> after every stamp.</footer>
</main>
</body>
</html>
`
}

export const REPORT_PATH = join('passport', 'report.html')

export function writeReport(projectRoot: string, html: string, out: string = REPORT_PATH): string {
  const file = isAbsolute(out) ? out : join(projectRoot, out)
  mkdirSync(dirname(file), {recursive: true})
  writeFileSync(file, html, 'utf8')
  return file
}
