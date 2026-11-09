/** The mounted profile menu publishes its status editor; the host shortcut opens it. */
export type StatusShortcut = { current?: (() => boolean) | undefined };

export const statusShortcut: StatusShortcut = {};
