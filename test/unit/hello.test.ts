import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {buildHelloReport, probeAcceptanceCriteria} from '../../src/core/hello.ts'
import {fakeHost} from '../helpers/fake-host.ts'

describe('probeAcceptanceCriteria', () => {
  it('reports missing criteria as not present', () => {
    assert.deepEqual(probeAcceptanceCriteria({id: 'a1'}), {length: 0, lineCount: 0, present: false})
  })

  it('treats whitespace-only criteria as not present', () => {
    assert.equal(probeAcceptanceCriteria({acceptanceCriteria: '  \n\t ', id: 'a1'}).present, false)
  })

  it('counts non-empty lines across Windows and Unix line endings', () => {
    const probe = probeAcceptanceCriteria({acceptanceCriteria: 'Refund routes to resolution\r\n\r\nCase is created\nUser is told the case number', id: 'a1'})
    assert.equal(probe.present, true)
    assert.equal(probe.lineCount, 3)
    assert.equal(probe.text?.startsWith('Refund routes'), true)
  })
})

describe('buildHelloReport', () => {
  it('maps auth status into table rows without inventing values', async () => {
    const {host} = fakeHost()
    const report = await buildHelloReport(host)
    assert.deepEqual(report.auth, [
      {configured: 'no', ready: '-', service: 'ai', source: '-'},
      {configured: 'yes', ready: '-', service: 'cicd', source: 'global'},
      {configured: 'no', ready: 'no', service: 'crt', source: 'global'},
    ])
    assert.equal(report.cliVersion, '1.1.0-test')
  })

  it('returns the active story and its acceptance criteria', async () => {
    const {calls, host} = fakeHost({
      workItem: {acceptanceCriteria: 'A refund request routes to the resolution subagent', id: 'a1X000', name: 'US-0000042', status: 'In Progress', title: 'Refund handling'},
      workspace: {baseBranch: 'main', branch: 'feature/US-0000042', defaults: {}, workItemName: 'US-0000042'},
    })
    const report = await buildHelloReport(host)
    assert.deepEqual(calls.getWorkItem, [undefined])
    assert.equal(report.workItem.found, true)
    if (report.workItem.found) {
      assert.equal(report.workItem.name, 'US-0000042')
      assert.equal(report.workItem.acceptanceCriteria.present, true)
      assert.equal(report.workItem.acceptanceCriteria.lineCount, 1)
    }
    assert.deepEqual(report.workspace, {baseBranch: 'main', branch: 'feature/US-0000042', found: true, workItemName: 'US-0000042'})
  })

  it('passes an explicit story id through to the host', async () => {
    const {calls, host} = fakeHost({workItem: {id: 'a1X000', name: 'US-0000007'}})
    await buildHelloReport(host, 'US-0000007')
    assert.deepEqual(calls.getWorkItem, ['US-0000007'])
  })

  it('reports a missing active story as data instead of throwing', async () => {
    const {host} = fakeHost()
    const report = await buildHelloReport(host)
    assert.equal(report.workItem.found, false)
    if (!report.workItem.found) assert.match(report.workItem.error, /No active work item/)
  })

  it('reports a workspace failure as data instead of throwing', async () => {
    const {host} = fakeHost({workspace: new Error('not a repository')})
    const report = await buildHelloReport(host)
    assert.deepEqual(report.workspace, {error: 'not a repository', found: false})
  })
})
