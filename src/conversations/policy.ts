/** NP0-attested ordinary-chat policy. Configuration echoes alone do not prove enforcement. */
export const projectlessCandidateVersion = '0.158.0-alpha.2.1';
export const projectlessPolicyRevision = 'ordinary-chat-clock-v1';
export const disabledFeatures = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'apps',
  'hooks',
  'plugins',
  'remote_plugin',
  'multi_agent',
  'multi_agent_v2',
  'memories',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'image_generation',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'js_repl',
  'js_repl_tools_only',
  'goals',
  'view_image',
  'workspace_dependencies',
  'worktrees',
  'skill_search',
  'skill_mcp_dependency_install',
  'sleep_tool',
  'tool_suggest',
  'in_app_local_automation',
];
export const projectlessCandidateConfig = {
  ...Object.fromEntries(disabledFeatures.map((feature) => [`features.${feature}`, false])),
  'agents.enabled': false,
  'features.skip_host_skill_discovery': true,
  web_search: 'disabled',
  notify: [],
  project_doc_max_bytes: 0,
};

/** Keep OS sandbox hints; exclude login secrets and the parent App's tool/IPC bindings. */
export function projectlessProbeEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const names = [
    'HOME',
    'PATH',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'CODEX_SANDBOX',
    'CODEX_SANDBOX_NETWORK_DISABLED',
  ];
  return Object.fromEntries(
    names
      .filter((name) => environment[name] !== undefined)
      .map((name) => [name, environment[name]]),
  );
}
