import { expect, it, vi } from "vitest";
import { encodeBrowserMediaFrame, fragmentBrowserMediaFrame } from "../shared/browser-media-wire";
import type { BrowserBinaryVideoPacket } from "../shared/browser-video";
import { browserVideoTestMetadata } from "../tests/fixtures/browser-video";
import { createBrowserMediaReceiver } from "./browser-media-receiver";

it("credits only its exact current decoded presentation once, never assembly or an equal clone", () => {
  let current = true;
  const pictures: BrowserBinaryVideoPacket[] = [],
    sendCredit = vi.fn();
  const receiver = createBrowserMediaReceiver({
    now: () => 0,
    isCurrent: () => current,
    onPicture: (p) => pictures.push(p),
    sendCredit,
  });
  try {
    for (const part of fragmentBrowserMediaFrame(
      encodeBrowserMediaFrame(browserVideoTestMetadata(), new Uint8Array(60000)),
      1,
    ))
      receiver.receive(part);
    expect(pictures).toHaveLength(1);
    expect(sendCredit).not.toHaveBeenCalled();
    receiver.presented({ ...pictures[0]! });
    expect(sendCredit).not.toHaveBeenCalled();
    receiver.presented(pictures[0]!);
    expect(sendCredit).toHaveBeenCalledOnce();
    expect(new DataView(sendCredit.mock.calls[0]![0].buffer).getUint32(0, true)).toBe(1);
    receiver.presented(pictures[0]!);
    expect(sendCredit).toHaveBeenCalledOnce();
    current = false;
    for (const part of fragmentBrowserMediaFrame(
      encodeBrowserMediaFrame(browserVideoTestMetadata(), new Uint8Array(60000)),
      2,
    ))
      receiver.receive(part);
    expect(pictures).toHaveLength(1);
  } finally {
    receiver.close();
  }
});
it("revokes late paint credit immediately at close", () => {
  let picture: BrowserBinaryVideoPacket | null = null;
  const sendCredit = vi.fn();
  const receiver = createBrowserMediaReceiver({
    now: () => 0,
    isCurrent: () => true,
    onPicture: (p) => {
      picture = p;
    },
    sendCredit,
  });
  for (const part of fragmentBrowserMediaFrame(
    encodeBrowserMediaFrame(browserVideoTestMetadata(), new Uint8Array(60000)),
    1,
  ))
    receiver.receive(part);
  expect(picture).not.toBeNull();
  receiver.close();
  receiver.presented(picture!);
  expect(sendCredit).not.toHaveBeenCalled();
});
