import { expect, it } from "vitest";
import type { PluginManifest } from "./api";
import { ownerName, resolveOwner } from "./owner";
import type { ConfigurationState } from "./types";

const manifest = (id: string, name: string): PluginManifest => ({
  id,
  name,
  apiVersion: 1,
});
const ready = (...manifests: PluginManifest[]): ConfigurationState => ({
  status: "ready",
  externalPluginsPaused: false,
  catalog: {
    profile: "test",
    location: "test",
    plugins: manifests.map((manifest) => ({
      manifest,
      source: "external",
      enabled: true,
      revision: "one",
      previous: null,
      reloadable: false,
      error: null,
    })),
  },
});
const loading: ConfigurationState = { status: "loading" };
const emoji = manifest("buzz.emoji", "Emoji");
const counter = manifest("example.counter", "Counter");

it("resolves a host-owned feature from its manifest before the catalog is read", () => {
  const snapshot = { hostOwned: [emoji], configuration: loading };
  expect(resolveOwner(snapshot, "buzz.emoji")).toEqual({
    manifest: emoji,
    hostOwned: true,
  });
  expect(ownerName(snapshot, "buzz.emoji")).toBe("Emoji");
});

it("resolves a catalog plugin as not host-owned", () => {
  const snapshot = { hostOwned: [emoji], configuration: ready(counter) };
  expect(resolveOwner(snapshot, "example.counter")).toEqual({
    manifest: counter,
    hostOwned: false,
  });
  expect(ownerName(snapshot, "example.counter")).toBe("Counter");
});

it("resolves the host-owned feature when a catalog entry shares its id", () => {
  // The manager never activates that entry: the host feature owns the id.
  const snapshot = {
    hostOwned: [emoji],
    configuration: ready(manifest("buzz.emoji", "Shadowed emoji")),
  };
  expect(resolveOwner(snapshot, "buzz.emoji")).toEqual({
    manifest: emoji,
    hostOwned: true,
  });
  expect(ownerName(snapshot, "buzz.emoji")).toBe("Emoji");
});

it("resolves no owner for an id listed nowhere, and names it by the id", () => {
  const snapshot = { hostOwned: [emoji], configuration: ready(counter) };
  expect(resolveOwner(snapshot, "example.unlisted")).toBeUndefined();
  expect(ownerName(snapshot, "example.unlisted")).toBe("example.unlisted");
  // A catalog plugin cannot be resolved until the catalog is read.
  const unread = { ...snapshot, configuration: loading };
  expect(resolveOwner(unread, "example.counter")).toBeUndefined();
  expect(ownerName(unread, "example.counter")).toBe("example.counter");
});
