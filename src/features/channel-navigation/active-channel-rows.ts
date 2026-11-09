/** Exiting row copies still have layout, but cannot receive focus or activation. */
export function activeChannelRows(root: ParentNode | null | undefined) {
  return [
    ...(root?.querySelectorAll<HTMLButtonElement>("button[data-channel-id]") ??
      []),
  ].filter((row) => !row.closest("[inert]"));
}
