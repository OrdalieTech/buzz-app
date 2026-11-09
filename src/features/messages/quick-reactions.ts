/** Clear shortcut preferences saved by older versions when leaving a community. */
export function forgetQuickReactions(scope: string) {
  localStorage.removeItem(`buzz.quick-reactions.v1:${scope}`);
}
