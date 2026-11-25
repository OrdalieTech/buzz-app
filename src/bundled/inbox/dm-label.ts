import { formatPublicKey } from "../../shared/identity/public-key";
import {
  dmNamedParticipants,
  sortParticipantNames,
} from "../../features/identity-names/participant-order";

/** One label recipe for Activity rows and details; callers own profile reads. */
export function dmLabel(
  participants: readonly string[] | undefined,
  profiles: ReadonlyMap<
    string,
    { name?: string | undefined; isAgent?: true | undefined }
  >,
  resolve: (
    key: string,
    fallback: string,
    candidates?: readonly string[],
  ) => string,
  missing = "Notes to self",
) {
  if (!participants) return missing;
  if (!participants.length) return "Notes to self";
  // Sort every name before bounding, so the shown three match other surfaces.
  const names = sortParticipantNames(
    dmNamedParticipants(participants, profiles).map((key) =>
      resolve(
        key,
        profiles.get(key)?.name ?? formatPublicKey(key) ?? "Unknown person",
        participants,
      ),
    ),
  );
  return (
    names.slice(0, 3).join(", ") +
    (names.length > 3 ? ` +${names.length - 3}` : "")
  );
}
