"use client";

// Phase 1t.6 extraction — Issue #3501
import { Button } from "@/shared/components";
import type { ProviderMessageTranslator } from "../providerPageHelpers";

interface CommandCodeAuthState {
  phase: string;
  [key: string]: unknown;
}

interface EmptyConnectionsPlaceholderProps {
  isCompatible: boolean;
  isCommandCode: boolean;
  providerId: string;
  providerSupportsPat: boolean;
  commandCodeAuthState: CommandCodeAuthState;
  gateConnectionFlow: (callback: () => void) => void;
  openApiKeyAddFlow: () => void;
  openPrimaryAddFlow: () => void;
  handleOpenCommandCodeConnect: () => void;
  t: ProviderMessageTranslator;
}

export default function EmptyConnectionsPlaceholder({
  isCompatible,
  isCommandCode,
  providerId,
  providerSupportsPat,
  commandCodeAuthState,
  gateConnectionFlow,
  openApiKeyAddFlow,
  openPrimaryAddFlow,
  handleOpenCommandCodeConnect,
  t,
}: EmptyConnectionsPlaceholderProps) {
  return (
    <div className="text-center py-12">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
        <span className="material-symbols-outlined text-[32px]">key</span>
      </div>
      <p className="text-text-main font-medium mb-1">{t("noConnectionsYet")}</p>
      <p className="text-sm text-text-muted mb-4">{t("addFirstConnectionHint")}</p>
      {!isCompatible && (
        <div className="flex items-center justify-center gap-2">
          {isCommandCode ? (
            <>
              <Button
                icon="open_in_new"
                loading={
                  isCommandCode &&
                  (commandCodeAuthState.phase === "starting" ||
                    commandCodeAuthState.phase === "polling" ||
                    commandCodeAuthState.phase === "applying")
                }
                onClick={() =>
                  gateConnectionFlow(
                    isCommandCode ? handleOpenCommandCodeConnect : openPrimaryAddFlow
                  )
                }
              >
                Connect
              </Button>
              <Button
                variant="secondary"
                icon="add"
                onClick={() => gateConnectionFlow(openApiKeyAddFlow)}
              >
                Manual API key
              </Button>
            </>
          ) : (
            <>
              <Button icon="add" onClick={() => gateConnectionFlow(openPrimaryAddFlow)}>
                {providerSupportsPat ? "Add PAT" : t("addConnection")}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
