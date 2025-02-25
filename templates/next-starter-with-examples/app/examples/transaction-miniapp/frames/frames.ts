import { createFrames } from "frames.js/next";
import { appURL } from "../../../utils";
import {
  farcasterHubContext,
  warpcastComposerActionState,
} from "frames.js/middleware";
import { DEFAULT_DEBUGGER_HUB_URL } from "../../../debug";

export const frames = createFrames({
  baseUrl: `${appURL()}/examples/transaction-miniapp/frames`,
  debug: process.env.NODE_ENV === "development",
  middleware: [
    farcasterHubContext({
      hubHttpUrl: DEFAULT_DEBUGGER_HUB_URL,
    }),
    warpcastComposerActionState(), // necessary to detect and parse state necessary for composer actions
  ],
});
