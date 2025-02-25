import "@farcaster/auth-kit/styles.css";
import { createAppClient, viemConnector, QRCode } from "@farcaster/auth-kit";
import { Button } from "@/components/ui/button";
import type { FrameLaunchedInContext } from "./frame-debugger";
import { WithTooltip } from "./with-tooltip";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useFrameAppInIframe } from "@frames.js/render/frame-app/iframe";
import { useCallback, useRef, useState } from "react";
import { useWagmiProvider } from "@frames.js/render/frame-app/provider/wagmi";
import { useToast } from "@/components/ui/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { DebuggerConsole } from "./debugger-console";
import Image from "next/image";
import { fallbackFrameContext } from "@frames.js/render";
import type { FarcasterSignerInstance } from "@frames.js/render/identity/farcaster";
import { FrameAppDebuggerNotifications } from "./frame-app-debugger-notifications";
import {
  FrameAppNotificationsManagerProvider,
  useFrameAppNotificationsManager,
} from "../providers/FrameAppNotificationsManagerProvider";
import { ToastAction } from "@/components/ui/toast";
import type {
  FramePrimaryButton,
  ResolveClientFunction,
} from "@frames.js/render/frame-app/types";
import { useConfig } from "wagmi";
import type { EIP6963ProviderInfo } from "@farcaster/frame-sdk";
import { z } from "zod";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useCopyToClipboard } from "../hooks/useCopyToClipboad";
import { FrameAppDebuggerViewProfileDialog } from "./frame-app-debugger-view-profile-dialog";

type TabValues = "events" | "console" | "notifications";

type FrameAppDebuggerProps = {
  context: FrameLaunchedInContext;
  farcasterSigner: FarcasterSignerInstance;
  onClose: () => void;
};

// in debugger we don't want to automatically reject repeated add frame calls
const addFrameRequestsCache = new (class extends Set {
  has(key: string) {
    return false;
  }

  add(key: string) {
    return this;
  }

  delete(key: string) {
    return true;
  }
})();

const appClient = createAppClient({
  ethereum: viemConnector(),
});

export function FrameAppDebugger({
  context,
  farcasterSigner,
  onClose,
}: FrameAppDebuggerProps) {
  const copyFarcasterSignInLink = useCopyToClipboard();
  const [
    farcasterSignInAbortControllerAndURL,
    setFarcasterSignInAbortControllerURL,
  ] = useState<{ controller: AbortController; url: URL } | null>(null);
  const config = useConfig();
  const farcasterSignerRef = useRef(farcasterSigner);
  farcasterSignerRef.current = farcasterSigner;

  const userContext = useRef<{ fid: number }>({ fid: -1 });

  if (
    (farcasterSigner.signer?.status === "approved" ||
      farcasterSigner.signer?.status === "impersonating") &&
    userContext.current.fid !== farcasterSigner.signer.fid
  ) {
    userContext.current = {
      fid: farcasterSigner.signer.fid,
    };
  }

  const frameAppNotificationManager = useFrameAppNotificationsManager({
    farcasterSigner,
    context,
  });
  const { toast } = useToast();
  const debuggerConsoleTabRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [activeTab, setActiveTab] = useState<TabValues>("notifications");
  const [isAppReady, setIsAppReady] = useState(false);
  const [primaryButton, setPrimaryButton] = useState<{
    button: FramePrimaryButton;
    callback: () => void;
  } | null>(null);
  const provider = useWagmiProvider({
    debug: true,
  });
  /**
   * we have to store promise in ref otherwise it will always invalidate the frame app hooks
   * which happens for example when you disable notifications from notifications panel
   */
  const frameAppNotificationManagerPromiseRef = useRef(
    frameAppNotificationManager.promise
  );
  const resolveClient: ResolveClientFunction = useCallback(async () => {
    try {
      const clientInfoResponse = await fetch("/client-info");

      if (!clientInfoResponse.ok) {
        throw new Error("Failed to fetch client info");
      }

      const parseClientInfo = z.object({
        fid: z.number().int(),
      });

      const clientInfo = parseClientInfo.parse(await clientInfoResponse.json());

      const { manager } = await frameAppNotificationManagerPromiseRef.current;
      const clientFid = clientInfo.fid;

      if (!manager.state || manager.state.frame.status === "removed") {
        return {
          clientFid,
          added: false,
        };
      }

      return {
        clientFid,
        added: true,
        notificationDetails:
          manager.state.frame.notificationDetails ?? undefined,
      };
    } catch (e) {
      console.error(e);

      toast({
        title: "Unexpected error",
        description:
          "Failed to load notifications settings. Check the console for more details.",
        variant: "destructive",
      });

      return {
        clientFid: -1,
        added: false,
      };
    }
  }, [toast]);
  const [viewFidProfile, setViewFidProfile] = useState<number | null>(null);
  const frameApp = useFrameAppInIframe({
    debug: true,
    source: context.parseResult,
    client: resolveClient,
    location:
      context.context === "button_press"
        ? {
            type: "launcher",
          }
        : {
            type: "cast_embed",
            embed: "",
            cast: fallbackFrameContext.castId,
          },
    user: userContext.current,
    provider,
    proxyUrl: "/frames",
    addFrameRequestsCache,
    onReady(options) {
      console.info("sdk.actions.ready() called", { options });
      setIsAppReady(true);
    },
    onClose() {
      console.info("sdk.actions.close() called");
      toast({
        title: "Frame app closed",
        description:
          "The frame app called close() action. Would you like to close it?",
        action: (
          <ToastAction
            altText="Close"
            onClick={() => {
              onClose();
            }}
          >
            Close
          </ToastAction>
        ),
      });
    },
    onOpenUrl(url) {
      console.info("sdk.actions.openUrl() called", { url });
      window.open(url, "_blank");
    },
    onPrimaryButtonSet(button, buttonCallback) {
      console.info("sdk.actions.setPrimaryButton() called", { button });
      setPrimaryButton({
        button,
        callback: () => {
          console.info("primary button clicked");
          buttonCallback();
        },
      });
    },
    async onAddFrameRequested(parseResult) {
      console.info("sdk.actions.addFrame() called");

      if (frameAppNotificationManager.status === "pending") {
        toast({
          title: "Notifications manager not ready",
          description:
            "Notifications manager is not ready. Please wait a moment.",
          variant: "destructive",
        });

        throw new Error("Notifications manager is not ready");
      }

      if (frameAppNotificationManager.status === "error") {
        toast({
          title: "Notifications manager error",
          description:
            "Notifications manager failed to load. Please check the console for more details.",
          variant: "destructive",
        });

        throw new Error("Notifications manager failed to load");
      }

      const webhookUrl = parseResult.manifest?.manifest.frame?.webhookUrl;

      if (!webhookUrl) {
        toast({
          title: "Webhook URL not found",
          description:
            "Webhook URL is not found in the manifest. It is required in order to enable notifications.",
          variant: "destructive",
        });

        return false;
      }

      // check what is the status of notifications for this app and signer
      // if there are no settings ask for user's consent and store the result
      const consent = window.confirm(
        "Do you want to add the frame to the app?"
      );

      if (!consent) {
        return false;
      }

      try {
        const result =
          await frameAppNotificationManager.data.manager.addFrame();

        return {
          added: true,
          notificationDetails: result,
        };
      } catch (e) {
        console.error(e);

        toast({
          title: "Failed to add frame",
          description:
            "Failed to add frame to the notifications manager. Check the console for more details.",
          variant: "destructive",
        });

        throw e;
      }
    },
    onEIP6963RequestProviderRequested({ endpoint }) {
      if (!config._internal.mipd) {
        return;
      }

      config._internal.mipd.getProviders().map((providerInfo) => {
        endpoint.emit({
          event: "eip6963:announceProvider",
          info: providerInfo.info as EIP6963ProviderInfo,
        });
      });
    },
    async onSignIn({ nonce, notBefore, expirationTime, frame }) {
      console.info("sdk.actions.signIn() called", {
        nonce,
        notBefore,
        expirationTime,
      });
      let abortTimeout: NodeJS.Timeout | undefined;

      try {
        const frameUrl = frame.frame.button?.action?.url;

        if (!frameUrl) {
          throw new Error("Frame is malformed, action url is missing");
        }

        const createChannelResult = await appClient.createChannel({
          nonce,
          notBefore,
          expirationTime,
          siweUri: frameUrl,
          domain: new URL(frameUrl).hostname,
        });

        if (createChannelResult.isError) {
          throw (
            createChannelResult.error ||
            new Error("Failed to create sign in channel")
          );
        }

        const abortController = new AbortController();

        setFarcasterSignInAbortControllerURL({
          controller: abortController,
          url: new URL(createChannelResult.data.url),
        });

        const signInTimeoutReason = "Sign in timed out";

        // abort controller after 30 seconds
        abortTimeout = setTimeout(() => {
          abortController.abort(signInTimeoutReason);
        }, 30000);

        let status: Awaited<ReturnType<typeof appClient.status>>;

        while (true) {
          if (abortController.signal.aborted) {
            if (abortTimeout) {
              clearTimeout(abortTimeout);
            }

            if (abortController.signal.reason === signInTimeoutReason) {
              toast({
                title: "Sign in timed out",
                variant: "destructive",
              });
            }

            throw new Error(abortController.signal.reason);
          }

          status = await appClient.status({
            channelToken: createChannelResult.data.channelToken,
          });

          if (!status.isError && status.data.state === "completed") {
            break;
          }

          await new Promise((r) => setTimeout(r, 1000));
        }

        clearTimeout(abortTimeout);

        const { message, signature } = status.data;

        if (!(signature && message)) {
          throw new Error("Signature or message is missing");
        }

        return {
          signature,
          message,
        };
      } finally {
        clearTimeout(abortTimeout);
        setFarcasterSignInAbortControllerURL(null);
      }
    },
    async onViewProfile(params) {
      console.info("sdk.actions.viewProfile() called", params);
      setViewFidProfile(params.fid);
    },
  });

  return (
    <>
      {!!farcasterSignInAbortControllerAndURL && (
        <Dialog
          open
          onOpenChange={() => {
            farcasterSignInAbortControllerAndURL.controller.abort(
              "User closed sign in dialog"
            );
          }}
        >
          <DialogContent className="max-w-[300px]">
            <div className="flex flex-col gap-4 justify-center items-center">
              <h2 className="text-xl font-semibold">Sign in with Farcaster</h2>
              <QRCode
                uri={farcasterSignInAbortControllerAndURL.url.toString()}
              />
              <span className="text-muted-foreground text-sm">or</span>
              <Button
                onClick={() => {
                  copyFarcasterSignInLink.copyToClipboard(
                    farcasterSignInAbortControllerAndURL.url.toString()
                  );
                }}
                variant="ghost"
              >
                {copyFarcasterSignInLink.copyState === "copied" && "Copied"}
                {copyFarcasterSignInLink.copyState === "idle" && "Copy link"}
                {copyFarcasterSignInLink.copyState === "failed" &&
                  "Copy failed"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[300px_500px_1fr] p-4 gap-4 bg-slate-50 max-w-full w-full">
        <div className="flex flex-col gap-4 order-1 lg:order-0">
          <div className="flex flex-row gap-2">
            <WithTooltip tooltip={<p>Reload frame app</p>}>
              <Button
                className="flex flex-row gap-3 items-center shadow-sm border"
                variant={"outline"}
                onClick={() => {
                  // reload iframe
                  if (iframeRef.current) {
                    iframeRef.current.src = "";
                    iframeRef.current.src = context.frame.button.action.url;
                    setIsAppReady(false);
                  }
                }}
              >
                <RefreshCwIcon size={20} />
              </Button>
            </WithTooltip>
          </div>
        </div>
        <div className="flex flex-col gap-4 order-0 lg:order-1">
          <div
            className="flex flex-col gap-1 w-[424px] h-[695px] relative"
            id="frame-app-preview"
          >
            {frameApp.status === "pending" ||
              (!isAppReady && (
                <div
                  className={cn(
                    "bg-white flex items-center justify-center absolute top-0 bottom-0 left-0 right-0"
                  )}
                  style={{
                    backgroundColor:
                      context.frame.button.action.splashBackgroundColor,
                  }}
                >
                  {context.frame.button.action.splashImageUrl && (
                    <div className="w-[200px] h-[200px] relative">
                      <Image
                        alt={`${name} splash image`}
                        src={context.frame.button.action.splashImageUrl}
                        width={200}
                        height={200}
                      />
                      <div className="absolute bottom-0 right-0">
                        <Loader2Icon
                          className="animate-spin text-primary"
                          size={40}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            {frameApp.status === "success" && (
              <>
                <iframe
                  className="flex h-full w-full border rounded-lg"
                  sandbox="allow-forms allow-scripts allow-same-origin"
                  {...frameApp.iframeProps}
                  ref={(r) => {
                    frameApp.iframeProps.ref.current = r;
                    iframeRef.current = r;
                  }}
                />
                {!!primaryButton && !primaryButton.button.hidden && (
                  <div className="w-full py-1">
                    <Button
                      className="w-full gap-2"
                      disabled={
                        primaryButton.button.disabled ||
                        primaryButton.button.loading
                      }
                      onClick={() => {
                        primaryButton.callback();
                      }}
                      size="lg"
                      type="button"
                    >
                      {primaryButton.button.loading && (
                        <Loader2Icon className="animate-spin" />
                      )}
                      {primaryButton.button.text}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex flex-row gap-4 order-2 md:col-span-2 lg:col-span-1 lg:order-2">
          {frameApp.status === "success" &&
          frameAppNotificationManager.status === "success" ? (
            <FrameAppNotificationsManagerProvider
              manager={frameAppNotificationManager.data.manager}
            >
              <Card className="w-full max-h-[600px]">
                <CardContent className="p-5 h-full">
                  <Tabs
                    value={activeTab}
                    onValueChange={(value) => setActiveTab(value as TabValues)}
                    className="grid grid-rows-[auto_1fr] w-full h-full"
                  >
                    <TabsList className={cn("grid w-full grid-cols-2")}>
                      <TabsTrigger value="notifications">
                        Notifications
                      </TabsTrigger>
                      <TabsTrigger value="console">Console</TabsTrigger>
                    </TabsList>
                    <TabsContent
                      className="overflow-hidden"
                      value="notifications"
                    >
                      <FrameAppDebuggerNotifications
                        frameApp={frameApp}
                        farcasterSigner={farcasterSigner.signer}
                      />
                    </TabsContent>
                    <TabsContent
                      className="overflow-y-auto"
                      ref={debuggerConsoleTabRef}
                      value="console"
                    >
                      <DebuggerConsole
                        onMount={(element) => {
                          if (debuggerConsoleTabRef.current) {
                            debuggerConsoleTabRef.current.scrollTo(
                              0,
                              element.scrollHeight
                            );
                          }
                        }}
                      />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            </FrameAppNotificationsManagerProvider>
          ) : null}
        </div>
      </div>
      {viewFidProfile !== null && (
        <FrameAppDebuggerViewProfileDialog
          fid={viewFidProfile}
          onDismiss={() => {
            setViewFidProfile(null);
          }}
        />
      )}
    </>
  );
}
