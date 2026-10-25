# Test fixture projects (real Salesforce sample files)

These are trimmed copies of Salesforce's official sample apps, used so the scanner is tested on real metadata, not hand-written guesses.
Files are unmodified copies; only unrelated files were left out. Each folder keeps its original licence.

| Folder | Source | Licence | What was kept |
|---|---|---|---|
| `agent-script-recipes/` | [trailheadapps/agent-script-recipes](https://github.com/trailheadapps/agent-script-recipes) (cloned Oct 23, 2026) | Apache-2.0 (`LICENSE.md`) | `sfdx-project.json`; all of `force-app-service/` (the Customer Service Agent, Agent Script model) except READMEs; the `HelloWorld` bundle and one `CreateCase` flow from `force-app/` |
| `cc/` (Coral Cloud) | [trailheadapps/coral-cloud](https://github.com/trailheadapps/coral-cloud) (cloned Oct 23, 2026) | CC0-1.0 (`LICENSE.md`) | `sfdx-project.json`; `bots`, `genAiPlannerBundles`, `genAiPlugins`, `genAiFunctions`, `genAiPromptTemplates` from `cc-employee-app` and `cc-service-app` (classic model); every Apex class, Flow and custom object those reference |

Known real-world issues these fixtures contain (the scanner must find them):
- `CustomerServiceAgent.agent` has `developer_name: "CustomerService_Agent"` but its bundle folder is `CustomerServiceAgent`, and it lives in `force-app-service`, which is not the default package directory. Both made `sf agent publish authoring-bundle` fail during setup.
- `CreateCase` exists in both `force-app` and `force-app-service`.
- The agent user is a placeholder (`__AGENT_USER_PLACEHOLDER__` / `%%SF_CC_PLACEHOLDER_USERNAME%%`). Coral Cloud replaces it at deploy time through `sfdx-project.json` `replacements`; the recipes project does not.
- Coral Cloud's agents use platform-provided actions and topics (`SvcCopilotTmpl__…`, `EmployeeCopilot__…`) that are not in the project.
