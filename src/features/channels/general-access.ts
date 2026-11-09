import type { ChannelDetailsDraft } from "../relay/channel-details-protocol";

export const generalAccessOptions = {
  private: {
    value: "private",
    label: "Private",
    description: "Only people you add can access.",
  },
  "view-only": {
    value: "view-only",
    label: "View only",
    description: "Anyone in the community can read.",
  },
  public: {
    value: "public",
    label: "Public",
    description: "Anyone in the community can participate.",
  },
} as const;

export type GeneralAccess = keyof typeof generalAccessOptions;
type Policy = Pick<ChannelDetailsDraft, "visibility" | "joinRole">;

export function generalAccessValue(policy: Policy): GeneralAccess {
  return policy.visibility === "private"
    ? "private"
    : policy.joinRole === "guest"
      ? "view-only"
      : "public";
}

/** Private retains the admission default; open policies state it explicitly. */
export function generalAccessPolicy(
  access: GeneralAccess,
  joinRole: Policy["joinRole"],
): Policy {
  return {
    visibility: access === "private" ? "private" : "public",
    joinRole:
      access === "private"
        ? joinRole
        : access === "view-only"
          ? "guest"
          : "member",
  };
}
