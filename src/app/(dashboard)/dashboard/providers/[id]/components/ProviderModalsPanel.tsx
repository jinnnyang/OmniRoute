"use client";

// Phase 1t.5 extraction — Issue #3501
// Pure composition of all modal elements rendered by ProviderDetailPageClient.
import { ConfirmModal, ProxyConfigModal } from "@/shared/components";
import RiskNoticeModal from "../../components/RiskNoticeModal";
import CodexCliGuideModal from "../../components/CodexCliGuideModal";
import SiliconFlowEndpointModal from "./SiliconFlowEndpointModal";
import KimiCodeAuthMethodModal from "./KimiCodeAuthMethodModal";
import AddApiKeyModal from "./modals/AddApiKeyModal";
import EditConnectionModal from "./modals/EditConnectionModal";
import EditCompatibleNodeModal from "./modals/EditCompatibleNodeModal";
import BatchTestResultsModal from "./BatchTestResultsModal";
import ImportProgressModal from "./ImportProgressModal";
import { AdaptaTutorialModal } from "./AdaptaTutorialModal";
import { type ConnectionRowConnection } from "./ConnectionRow";
import { type BatchTestResults } from "../hooks/useProviderConnections";
import { type ConnectionDeleteConfirmState } from "../hooks/useConnectionDeleteConfirm";
import { type ImportProgress } from "../hooks/useModelImportHandlers";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";

interface ProviderInfo {
  name: string;
  riskNoticeVariant?: string;
  website?: string;
  [key: string]: unknown;
}

interface ProxyTarget {
  level: string;
  id: string;
  label: string;
}

interface ProviderModalsPanelProps {
  providerId: string;
  providerInfo: ProviderInfo;
  isCompatible: boolean;
  isAnthropicProtocolCompatible: boolean;
  isCcCompatible: boolean;
  isCommandCode: boolean;
  isUpstreamProxyProvider: boolean;
  subscriptionRisk: boolean;
  existingConnectionCount?: number;
  // Risk notice
  showRiskNoticeModal: boolean;
  handleConfirmRiskNotice: () => void;
  handleCancelRiskNotice: () => void;
  // Provider-specific auth method selection
  showKimiAuthMethodModal: boolean;
  setShowKimiAuthMethodModal: (open: boolean) => void;
  // SiliconFlow
  showSiliconFlowEndpointModal: boolean;
  setSiliconFlowInitialBaseUrl: (url: string | undefined) => void;
  setShowSiliconFlowEndpointModal: (open: boolean) => void;
  setShowAddApiKeyModal: (open: boolean) => void;
  // AddApiKey
  showAddApiKeyModal: boolean;
  siliconFlowInitialBaseUrl: string | undefined;
  commandCodeAuthState: { phase: string; [key: string]: unknown };
  handleStartCommandCodeAuth: () => void;
  handleSaveApiKey: (data: any) => Promise<void>;
  handleCloseAddApiKeyModal: () => void;
  // Batch delete confirm
  batchDeleteConfirmOpen: boolean;
  setBatchDeleteConfirmOpen: (open: boolean) => void;
  handleBatchDeleteConfirm: () => void;
  selectedIds: Set<string>;
  batchDeleting: boolean;
  // Single-connection delete confirm
  deleteConfirm: ConnectionDeleteConfirmState;
  // Edit connection
  showEditModal: boolean;
  setShowEditModal: (open: boolean) => void;
  selectedConnection: ConnectionRowConnection | null;
  handleUpdateConnection: (data: any) => Promise<string | null>;
  handleCompatibleImportWithProgress: (
    connectionId: string,
    mode?: "import" | "sync"
  ) => Promise<void>;
  // Edit compatible node
  showEditNodeModal: boolean;
  setShowEditNodeModal: (open: boolean) => void;
  providerNode: any;
  handleUpdateNode: (data: any) => Promise<void>;
  // Codex CLI guide
  codexCliGuideOpen: boolean;
  setCodexCliGuideOpen: (open: boolean) => void;
  // Batch test results
  batchTestResults: BatchTestResults | null;
  setBatchTestResults: (r: BatchTestResults | null) => void;
  emailsVisible: boolean;
  // Proxy config
  proxyTarget: ProxyTarget | null;
  setProxyTarget: (t: ProxyTarget | null) => void;
  fetchProxyConfig: () => Promise<void>;
  // Import progress
  importProgress: ImportProgress;
  showImportModal: boolean;
  setShowImportModal: (open: boolean) => void;
  // Tutorial
  showTutorialModal: boolean;
  setShowTutorialModal: (open: boolean) => void;
  t: ProviderMessageTranslator;
}

export default function ProviderModalsPanel({
  providerId,
  providerInfo,
  isCompatible,
  isAnthropicProtocolCompatible,
  isCcCompatible,
  isUpstreamProxyProvider,
  subscriptionRisk,
  existingConnectionCount,
  showRiskNoticeModal,
  handleConfirmRiskNotice,
  handleCancelRiskNotice,
  showKimiAuthMethodModal,
  setShowKimiAuthMethodModal,
  showSiliconFlowEndpointModal,
  setSiliconFlowInitialBaseUrl,
  setShowSiliconFlowEndpointModal,
  setShowAddApiKeyModal,
  showAddApiKeyModal,
  siliconFlowInitialBaseUrl,
  commandCodeAuthState,
  handleStartCommandCodeAuth,
  handleSaveApiKey,
  handleCloseAddApiKeyModal,
  isCommandCode,
  batchDeleteConfirmOpen,
  setBatchDeleteConfirmOpen,
  handleBatchDeleteConfirm,
  selectedIds,
  batchDeleting,
  deleteConfirm,
  showEditModal,
  setShowEditModal,
  selectedConnection,
  handleUpdateConnection,
  handleCompatibleImportWithProgress,
  showEditNodeModal,
  setShowEditNodeModal,
  providerNode,
  handleUpdateNode,
  codexCliGuideOpen,
  setCodexCliGuideOpen,
  batchTestResults,
  setBatchTestResults,
  emailsVisible,
  proxyTarget,
  setProxyTarget,
  fetchProxyConfig,
  importProgress,
  showImportModal,
  setShowImportModal,
  showTutorialModal,
  setShowTutorialModal,
  t,
}: ProviderModalsPanelProps) {
  return (
    <>
      {showRiskNoticeModal && subscriptionRisk && (
        <RiskNoticeModal
          variant={
            (providerInfo.riskNoticeVariant ?? "deprecated") as "deprecated" | "embedded-service"
          }
          providerId={providerId}
          providerName={providerInfo.name}
          onConfirm={handleConfirmRiskNotice}
          onCancel={handleCancelRiskNotice}
        />
      )}
      {providerId === "kimi-coding" && (
        <KimiCodeAuthMethodModal
          isOpen={showKimiAuthMethodModal}
          onSelectApiKey={() => {
            setShowKimiAuthMethodModal(false);
            setShowAddApiKeyModal(true);
          }}
          onClose={() => setShowKimiAuthMethodModal(false)}
          t={t}
        />
      )}
      {providerId === "siliconflow" && (
        <SiliconFlowEndpointModal
          isOpen={showSiliconFlowEndpointModal}
          onSelect={(baseUrl) => {
            setSiliconFlowInitialBaseUrl(baseUrl);
            setShowSiliconFlowEndpointModal(false);
            setShowAddApiKeyModal(true);
          }}
          onClose={() => {
            setShowSiliconFlowEndpointModal(false);
            setSiliconFlowInitialBaseUrl(undefined);
          }}
        />
      )}
      {!isUpstreamProxyProvider && (
        <AddApiKeyModal
          isOpen={showAddApiKeyModal}
          provider={providerId}
          providerName={providerInfo.name}
          providerWebsite={providerInfo.website}
          initialBaseUrl={siliconFlowInitialBaseUrl}
          existingConnectionCount={existingConnectionCount}
          isCompatible={isCompatible}
          isAnthropic={isAnthropicProtocolCompatible}
          isCcCompatible={isCcCompatible}
          isCommandCode={isCommandCode}
          commandCodeAuthState={commandCodeAuthState}
          onStartCommandCodeAuth={handleStartCommandCodeAuth}
          onSave={handleSaveApiKey}
          onClose={handleCloseAddApiKeyModal}
        />
      )}
      <ConfirmModal
        isOpen={batchDeleteConfirmOpen}
        onClose={() => setBatchDeleteConfirmOpen(false)}
        onConfirm={handleBatchDeleteConfirm}
        title={t("batchDeleteConfirmTitle", "Delete connections")}
        message={t("batchDeleteConfirm", { count: selectedIds.size })}
        confirmText={t("batchDeleteConfirmButton", "Delete")}
        cancelText={t("cancel", "Cancel")}
        loading={batchDeleting}
      />
      <ConfirmModal
        isOpen={!!deleteConfirm.connection}
        onClose={deleteConfirm.cancel}
        onConfirm={deleteConfirm.confirm}
        title={providerText(t, "deleteConnectionConfirm", "Delete this connection?")}
        message={providerText(
          t,
          "deleteConnectionConfirmNamed",
          "Are you sure you want to delete {name}? This action cannot be undone.",
          { name: deleteConfirm.connection?.name ?? "" }
        )}
        confirmText={providerText(t, "batchDeleteConfirmButton", "Delete")}
        cancelText={providerText(t, "cancel", "Cancel")}
        loading={deleteConfirm.deleting}
      />
      {!isUpstreamProxyProvider && (
        <EditConnectionModal
          isOpen={showEditModal}
          connection={selectedConnection}
          providerId={providerId}
          providerWebsite={providerInfo.website}
          onSave={handleUpdateConnection}
          onResyncModels={(id) => handleCompatibleImportWithProgress(id, "sync")}
          onClose={() => setShowEditModal(false)}
        />
      )}
      {!isUpstreamProxyProvider && isCompatible && (
        <EditCompatibleNodeModal
          isOpen={showEditNodeModal}
          node={providerNode}
          onSave={handleUpdateNode}
          onClose={() => setShowEditNodeModal(false)}
          isAnthropic={isAnthropicProtocolCompatible}
          isCcCompatible={isCcCompatible}
        />
      )}
      <CodexCliGuideModal isOpen={codexCliGuideOpen} onClose={() => setCodexCliGuideOpen(false)} />
      <BatchTestResultsModal
        batchTestResults={batchTestResults}
        providerInfo={providerInfo}
        providerId={providerId}
        emailsVisible={emailsVisible}
        onClose={() => setBatchTestResults(null)}
        t={t}
      />
      {proxyTarget && (
        <ProxyConfigModal
          isOpen={!!proxyTarget}
          onClose={() => setProxyTarget(null)}
          level={proxyTarget.level}
          levelId={proxyTarget.id}
          levelLabel={proxyTarget.label}
          onSaved={() => {
            void fetchProxyConfig();
          }}
        />
      )}
      <ImportProgressModal
        importProgress={importProgress}
        isOpen={showImportModal}
        onClose={() => {
          if (importProgress.phase === "done" || importProgress.phase === "error") {
            setShowImportModal(false);
          }
        }}
        t={t}
      />
      {providerId === "adapta-web" && (
        <AdaptaTutorialModal
          isOpen={showTutorialModal}
          onClose={() => setShowTutorialModal(false)}
        />
      )}
    </>
  );
}
