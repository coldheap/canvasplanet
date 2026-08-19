import { SUB_ZOOM } from "@canvasplanet/shared";
import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../protocol.js";

describe("parseClientMessage", () => {
  it("accepts ping and canonical in-world subscriptions", () => {
    expect(parseClientMessage('{"t":"ping"}')).toEqual({ t: "ping" });
    expect(parseClientMessage(`{"t":"sub","tiles":["${SUB_ZOOM}/0/0"]}`)).toEqual({
      t: "sub",
      tiles: [`${SUB_ZOOM}/0/0`],
    });
  });

  it("rejects missing, malformed and out-of-world tile lists", () => {
    const edge = 2 ** SUB_ZOOM;
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage('{"t":"sub"}')).toBeNull();
    expect(parseClientMessage('{"t":"sub","tiles":"nope"}')).toBeNull();
    expect(parseClientMessage(`{"t":"sub","tiles":["${SUB_ZOOM}/${edge}/0"]}`)).toBeNull();
    expect(parseClientMessage(`{"t":"sub","tiles":["${SUB_ZOOM}/01/0"]}`)).toBeNull();
  });

  it("rejects subscription floods before they reach the hub", () => {
    const tiles = Array.from({ length: 65 }, () => `${SUB_ZOOM}/0/0`);
    expect(parseClientMessage(JSON.stringify({ t: "sub", tiles }))).toBeNull();
  });
});
