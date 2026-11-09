# Plugin development

Lets agents on this device write Buzz plugins and try their changes, without a copy of the Buzz source.

## Getting started

1. Ask an agent running on this device to build a plugin. It reads the plugin guide that comes with Buzz and writes the plugin in a folder.
2. Install it once: in **Manage plugins**, choose **Add**, then **Browse** under Add from folder, pick that folder and choose **Install plugin**. Use **Browse**: a folder you drag in is copied, so the agent can't reload it.
3. From then on the agent reloads the plugin after each change. If a change fails to start, the version that was running comes back.
4. When a change asks for new host access, such as a command or website, the agent can't apply it. Review it with the plugin's **Update**.

Turning this off removes the three agent tools: `plugin_authoring_guide`, `plugin_status` and `plugin_reload`. Codex agents start a new thread when the tools change.
