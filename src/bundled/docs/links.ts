// Only this plugin's address grammar. General Buzz links belong to host Markdown.
export const PLUGIN_ID = "com.squareup.docs";
export const PAGE_ID = "docs";
const UUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export function communityOrigin(input: string) {
  const value = input.trim();
  if (
    value.length > 2048 ||
    !/^(?:wss|https):\/\/[^/?#\\\s@]+\/?$/i.test(value)
  )
    throw new Error(
      "Use a secure community origin without credentials or a path.",
    );
  const url = new URL(value);
  url.protocol = "https:";
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  return url.origin;
}

export function docLink(
  address: { id: string; channel: string },
  community: string,
) {
  if (!UUID.test(address.id) || !UUID.test(address.channel))
    throw new Error("Invalid doc address.");
  const url = new URL("buzz://plugin");
  url.searchParams.set("id", PLUGIN_ID);
  url.searchParams.set("page", PAGE_ID);
  url.searchParams.set("route.view", "doc");
  url.searchParams.set("route.community", communityOrigin(community));
  url.searchParams.set("route.channel", address.channel);
  url.searchParams.set("route.id", address.id);
  return url.href;
}

export function parseDocLink(
  value: string,
): { id: string; channel: string; community: string } | undefined {
  try {
    const url = new URL(value);
    if (
      !/^buzz:\/\/plugin\/?\?/i.test(value) ||
      url.protocol !== "buzz:" ||
      url.hostname !== "plugin" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/") ||
      [...url.searchParams.keys()].sort().join() !==
        "id,page,route.channel,route.community,route.id,route.view" ||
      url.searchParams.get("id") !== PLUGIN_ID ||
      url.searchParams.get("page") !== PAGE_ID ||
      url.searchParams.get("route.view") !== "doc"
    )
      return;
    const id = url.searchParams.get("route.id") ?? "";
    const channel = url.searchParams.get("route.channel") ?? "";
    if (!UUID.test(id) || !UUID.test(channel)) return;
    return {
      id,
      channel,
      community: communityOrigin(url.searchParams.get("route.community") ?? ""),
    };
  } catch {
    return;
  }
}
