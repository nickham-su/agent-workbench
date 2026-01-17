<template>
  <div class="flex flex-col min-h-0">


    <div class="px-5 pb-5 min-h-0 overflow-auto">
      <a-tabs v-model:activeKey="innerKey" size="small" :animated="false">
        <a-tab-pane key="general" :tab="t('settings.tabs.general')">
          <a-form layout="vertical">
            <a-form-item :label="t('settings.general.language.label')">
              <a-select v-model:value="uiLocale" :options="languageOptions" style="max-width: 260px" />
              <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">{{ t("settings.general.language.help") }}</div>
            </a-form-item>

            <a-form-item :label="t('settings.general.fontSize.terminal.label')">
              <a-input-number
                v-model:value="terminalFontSizeModel"
                :min="uiFontSizeDefaults.min"
                :max="uiFontSizeDefaults.max"
                :step="1"
                style="max-width: 260px"
              />
              <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
                {{ t("settings.general.fontSize.terminal.help", { default: uiFontSizeDefaults.default }) }}
              </div>
            </a-form-item>

            <a-form-item :label="t('settings.general.fontSize.diff.label')">
              <a-input-number
                v-model:value="diffFontSizeModel"
                :min="uiFontSizeDefaults.min"
                :max="uiFontSizeDefaults.max"
                :step="1"
                style="max-width: 260px"
              />
              <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
                {{ t("settings.general.fontSize.diff.help", { default: uiFontSizeDefaults.default }) }}
              </div>
            </a-form-item>
          </a-form>
        </a-tab-pane>

        <a-tab-pane key="gitIdentity" :tab="t('settings.tabs.gitIdentity')">
          <div class="text-xs text-[color:var(--text-tertiary)] pb-2">
            {{ t("settings.gitIdentity.description") }}
          </div>

          <a-form layout="vertical">
            <a-form-item :label="t('settings.gitIdentity.form.nameLabel')">
              <a-input v-model:value="gitGlobalName" :placeholder="t('settings.gitIdentity.form.namePlaceholder')" style="max-width: 420px" />
            </a-form-item>
            <a-form-item :label="t('settings.gitIdentity.form.emailLabel')">
              <a-input v-model:value="gitGlobalEmail" :placeholder="t('settings.gitIdentity.form.emailPlaceholder', { at: '@' })" style="max-width: 420px" />
            </a-form-item>
            <div class="flex items-center gap-2">
              <a-button size="small" :loading="gitIdentitySaving" @click="saveGitIdentity">{{ t("settings.gitIdentity.actions.save") }}</a-button>
              <a-button size="small" type="text" :loading="gitIdentityLoading" @click="refreshGitIdentity">{{ t("settings.gitIdentity.actions.refresh") }}</a-button>
              <a-button size="small" danger :loading="gitIdentityClearing" @click="clearAllIdentityWithUi">
                {{ t("settings.gitIdentity.actions.clearAll") }}
              </a-button>
            </div>
          </a-form>
        </a-tab-pane>

        <a-tab-pane key="credentials" :tab="t('settings.tabs.credentials')">
          <div class="flex items-center justify-between pb-2">
            <div class="text-xs text-[color:var(--text-tertiary)]">
              {{ t("settings.credentials.description") }}
            </div>
            <a-button size="small" @click="openCreateCredential">{{ t("settings.credentials.actions.add") }}</a-button>
          </div>

          <div v-if="!credLoading && credentials.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.credentials.empty") }}
          </div>
          <div v-else class="divide-y divide-[var(--border-color-secondary)]">
            <div
              v-for="c in credentials"
              :key="c.id"
              class="group flex items-center justify-between gap-3 py-2 px-2 rounded hover:bg-[var(--panel-bg-elevated)]"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 min-w-0">
                  <div class="font-mono text-xs truncate" :title="c.host">{{ c.host }}</div>
                  <a-tag v-if="c.isDefault" color="blue" class="!text-[10px] !leading-[16px] !px-1 !py-0">{{ t("settings.credentials.tags.default") }}</a-tag>
                  <a-tag color="default" class="!text-[10px] !leading-[16px] !px-1 !py-0">{{ credentialKindLabel(c.kind) }}</a-tag>
                </div>
                <div class="text-[11px] text-[color:var(--text-tertiary)] pt-1">
                  <span v-if="c.label">{{ c.label }}</span>
                  <span v-if="c.label && c.username"> · </span>
                  <span v-if="c.username">{{ c.username }}</span>
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
                <a-button
                  size="small"
                  type="text"
                  @click="openEditCredential(c)"
                  :title="t('settings.credentials.actions.edit')"
                  :aria-label="t('settings.credentials.actions.edit')"
                >
                  <template #icon><EditOutlined /></template>
                </a-button>
                <a-button
                  size="small"
                  type="text"
                  danger
                  @click="confirmDeleteCredential(c)"
                  :title="t('settings.credentials.actions.delete')"
                  :aria-label="t('settings.credentials.actions.delete')"
                >
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </div>
            </div>
          </div>

          <a-modal
            v-model:open="credentialModalOpen"
            :title="credentialModalTitle"
            :confirm-loading="credentialSaving"
            :maskClosable="false"
            :okText="t('settings.credentials.modal.ok')"
            :cancelText="t('settings.credentials.modal.cancel')"
            @ok="submitCredential"
          >
            <a-form layout="vertical">
              <a-form-item v-if="credentialModalMode === 'create'" :label="t('settings.credentials.form.hostLabel')" required>
                <a-input v-model:value="formHost" :placeholder="t('settings.credentials.form.hostPlaceholder')" />
              </a-form-item>

              <a-form-item v-if="credentialModalMode === 'create'" :label="t('settings.credentials.form.kindLabel')" required>
                <a-radio-group v-model:value="formKind" button-style="solid">
                  <a-radio-button value="https">{{ t("settings.credentials.form.kindHttps") }}</a-radio-button>
                  <a-radio-button value="ssh">{{ t("settings.credentials.form.kindSsh") }}</a-radio-button>
                </a-radio-group>
              </a-form-item>

              <a-form-item :label="t('settings.credentials.form.labelLabel')">
                <a-input v-model:value="formLabel" :placeholder="t('settings.credentials.form.labelPlaceholder')" />
              </a-form-item>

              <a-form-item :label="t('settings.credentials.form.usernameLabel')">
                <a-input v-model:value="formUsername" :placeholder="credentialUsernamePlaceholder" />
              </a-form-item>

              <a-form-item :label="credentialSecretLabel" :required="credentialModalMode === 'create'">
                <a-textarea v-model:value="formSecret" :rows="6" :placeholder="t('settings.credentials.form.secretPlaceholder')" />
                <div v-if="formKind === 'ssh'" class="pt-2 flex items-center gap-2">
                  <a-button size="small" :loading="sshKeypairGenerating" @click="generateSshKeypairWithUi">
                    {{ t("settings.credentials.actions.generateSshKey") }}
                  </a-button>
                  <div class="text-xs text-[color:var(--text-tertiary)]">
                    {{ t("settings.credentials.form.generateSshHelp") }}
                  </div>
                </div>
              </a-form-item>

              <a-form-item v-if="formKind === 'ssh' && generatedPublicKey" :label="t('settings.credentials.form.publicKeyLabel')">
                <a-textarea :value="generatedPublicKey" :rows="2" readonly class="font-mono" />
                <div class="pt-2 flex items-center gap-2">
                  <a-button size="small" @click="copyGeneratedPublicKey">{{ t("settings.credentials.actions.copyPublicKey") }}</a-button>
                  <div class="text-xs text-[color:var(--text-tertiary)]">
                    {{ t("settings.credentials.form.publicKeyHelp") }}
                  </div>
                </div>
              </a-form-item>

              <a-form-item>
                <a-checkbox v-model:checked="formIsDefault">{{ t("settings.credentials.form.isDefault") }}</a-checkbox>
              </a-form-item>
            </a-form>
            <div class="text-xs text-[color:var(--text-tertiary)]">
              {{ t("settings.credentials.tip") }}
            </div>
          </a-modal>
        </a-tab-pane>
        <a-tab-pane key="network" :tab="t('settings.tabs.network')">
          <div class="text-xs text-[color:var(--text-tertiary)] pb-2">
            {{ t("settings.network.description") }}
          </div>
          <a-form layout="vertical">
            <a-form-item :label="t('settings.network.form.httpProxyLabel')">
              <a-input v-model:value="networkHttpProxy" :placeholder="t('settings.network.form.httpProxyPlaceholder')" />
            </a-form-item>
            <a-form-item :label="t('settings.network.form.httpsProxyLabel')">
              <a-input v-model:value="networkHttpsProxy" :placeholder="t('settings.network.form.httpsProxyPlaceholder')" />
            </a-form-item>
            <a-form-item :label="t('settings.network.form.noProxyLabel')">
              <a-input v-model:value="networkNoProxy" :placeholder="t('settings.network.form.noProxyPlaceholder')" />
            </a-form-item>
            <a-form-item :label="t('settings.network.form.caCertLabel')">
              <a-textarea v-model:value="networkCaPem" :rows="8" :placeholder="t('settings.network.form.caCertPlaceholder')" />
            </a-form-item>
            <a-form-item>
              <div class="flex items-start gap-2">
                <a-checkbox v-model:checked="networkApplyToTerminal">{{ t("settings.network.form.applyToTerminalLabel") }}</a-checkbox>
                <div class="text-[11px] text-[color:var(--text-tertiary)] leading-4 pt-[2px]">
                  <div>{{ t("settings.network.form.applyToTerminalEffect") }}</div>
                  <div>{{ t("settings.network.form.applyToTerminalRisk") }}</div>
                </div>
              </div>
            </a-form-item>
            <div class="flex items-center gap-2">
              <a-button size="small" :loading="networkSaving" @click="saveNetwork">{{ t("settings.network.actions.save") }}</a-button>
              <a-button size="small" type="text" :loading="networkLoading" @click="refreshNetwork">{{ t("settings.network.actions.refresh") }}</a-button>
            </div>
          </a-form>
        </a-tab-pane>
        <a-tab-pane key="security" :tab="t('settings.tabs.security')">
          <div class="text-xs text-[color:var(--text-tertiary)] pb-2">
            {{ t("settings.security.description") }}
          </div>

          <div v-if="security" class="space-y-3">
            <div class="bg-[var(--panel-bg-elevated)] border border-[var(--border-color-secondary)] rounded p-3">
              <div class="text-xs font-semibold pb-1">{{ t("settings.security.masterKeyTitle") }}</div>
              <div class="text-xs text-[color:var(--text-tertiary)]">
                <div>{{ t("settings.security.fields.source") }}: <span class="font-mono">{{ security.credentialMasterKey.source }}</span></div>
                <div>{{ t("settings.security.fields.keyId") }}: <span class="font-mono">{{ security.credentialMasterKey.keyId }}</span></div>
                <div v-if="security.credentialMasterKey.createdAt">
                  {{ t("settings.security.fields.createdAt") }}: <span class="font-mono">{{ security.credentialMasterKey.createdAt }}</span>
                </div>
              </div>
            </div>

            <div class="bg-[var(--panel-bg-elevated)] border border-[var(--border-color-secondary)] rounded p-3">
              <div class="text-xs font-semibold pb-1">{{ t("settings.security.knownHostsTitle") }}</div>
              <div class="text-xs text-[color:var(--text-tertiary)]">
                <div>{{ t("settings.security.fields.path") }}: <span class="font-mono break-all">{{ security.sshKnownHostsPath }}</span></div>
              </div>

              <div class="pt-3 flex items-center gap-2">
                <a-input v-model:value="resetHost" size="small" :placeholder="t('settings.security.resetHostPlaceholder')" />
                <a-button size="small" danger :loading="resettingHost" @click="resetKnownHostWithUi">{{ t("settings.security.resetTrust") }}</a-button>
              </div>
              <div class="text-xs text-[color:var(--text-tertiary)] pt-2">
                {{ t("settings.security.resetHelp") }}
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-[color:var(--text-tertiary)]">
            {{ t("common.loading") }}
          </div>
        </a-tab-pane>
      </a-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Modal, message } from "ant-design-vue";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons-vue";
import type { CredentialKind, CredentialRecord, SecurityStatus } from "@agent-workbench/shared";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { diffFontSize, setDiffFontSize, setTerminalFontSize, terminalFontSize, uiFontSizeDefaults } from "@/shared/settings/uiFontSizes";
import {
  clearAllGitIdentity,
  createCredential,
  deleteCredential,
  generateSshKeypair,
  getGitGlobalIdentity,
  getNetworkSettings,
  getSecurityStatus,
  listCredentials,
  resetKnownHost,
  updateCredential,
  updateGitGlobalIdentity,
  updateNetworkSettings
} from "@/shared/api";
import { getInitialLocale, setStoredLocale, type AppLocale } from "@/shared/i18n/locale";

const { t, locale } = useI18n();

const route = useRoute();
const router = useRouter();

const settingsTabKeys = ["general", "gitIdentity", "credentials", "network", "security"] as const;
type SettingsTabKey = (typeof settingsTabKeys)[number];

function normalizeSettingsTabKey(v: unknown): SettingsTabKey {
  const raw = Array.isArray(v) ? v[0] : v;
  const k = String(raw ?? "");
  if ((settingsTabKeys as readonly string[]).includes(k)) return k as SettingsTabKey;
  return "general";
}

// 二级 tabs 与 URL 同步：/settings/<tab>
const innerKey = computed<SettingsTabKey>({
  get: () => normalizeSettingsTabKey(route.params.tab),
  set: (k) => {
    void router.push(`/settings/${k}`);
  }
});

const uiLocale = ref<AppLocale>(getInitialLocale());
const languageOptions = computed(() => [
  { value: "zh-CN", label: t("settings.general.language.options.zh-CN") },
  { value: "en-US", label: t("settings.general.language.options.en-US") }
]);

const terminalFontSizeModel = computed<number | null>({
  get: () => terminalFontSize.value,
  set: (v) => {
    if (v === null || v === undefined) return;
    setTerminalFontSize(v);
  }
});

const diffFontSizeModel = computed<number | null>({
  get: () => diffFontSize.value,
  set: (v) => {
    if (v === null || v === undefined) return;
    setDiffFontSize(v);
  }
});

const gitIdentityLoading = ref(false);
const gitIdentitySaving = ref(false);
const gitIdentityClearing = ref(false);
const gitGlobalName = ref("");
const gitGlobalEmail = ref("");

async function refreshGitIdentity() {
  if (gitIdentityLoading.value) return;
  gitIdentityLoading.value = true;
  try {
    const res = await getGitGlobalIdentity();
    gitGlobalName.value = res.name || "";
    gitGlobalEmail.value = res.email || "";
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    gitIdentityLoading.value = false;
  }
}

async function saveGitIdentity() {
  if (gitIdentitySaving.value) return;
  const name = gitGlobalName.value.trim();
  const email = gitGlobalEmail.value.trim();
  if (!name || !email) return;
  gitIdentitySaving.value = true;
  try {
    await updateGitGlobalIdentity({ name, email });
    message.success(t("settings.gitIdentity.saved"));
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    gitIdentitySaving.value = false;
  }
}

function clearAllIdentityWithUi() {
  if (gitIdentityClearing.value) return;
  Modal.confirm({
    title: t("settings.gitIdentity.clearAllConfirm.title"),
    content: t("settings.gitIdentity.clearAllConfirm.content"),
    okText: t("settings.gitIdentity.clearAllConfirm.ok"),
    okType: "danger",
    cancelText: t("settings.gitIdentity.clearAllConfirm.cancel"),
    onOk: async () => {
      gitIdentityClearing.value = true;
      try {
        const res = await clearAllGitIdentity();
        if (!res.ok && res.errors.length > 0) {
          message.warning(t("settings.gitIdentity.clearedWithErrors", { count: res.errors.length }));
        } else {
          message.success(t("settings.gitIdentity.cleared"));
        }
        await refreshGitIdentity();
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        gitIdentityClearing.value = false;
      }
    }
  });
}

watch(
  () => uiLocale.value,
  (next) => {
    if (next === locale.value) return;
    locale.value = next;
    setStoredLocale(next);
    message.success(t("settings.general.language.changed"));
  }
);

const credLoading = ref(false);
const credentials = ref<CredentialRecord[]>([]);
async function refreshCredentials() {
  credLoading.value = true;
  try {
    credentials.value = await listCredentials();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    credLoading.value = false;
  }
}

const credentialModalOpen = ref(false);
const credentialSaving = ref(false);
const credentialModalMode = ref<"create" | "edit">("create");
const editingCredentialId = ref<string | null>(null);

const formHost = ref("");
const formKind = ref<CredentialKind>("https");
const formLabel = ref("");
const formUsername = ref("");
const formSecret = ref("");
const formIsDefault = ref(false);
const sshKeypairGenerating = ref(false);
const generatedPublicKey = ref("");

const credentialModalTitle = computed(() =>
  credentialModalMode.value === "create" ? t("settings.credentials.modal.createTitle") : t("settings.credentials.modal.editTitle")
);

const credentialUsernamePlaceholder = computed(() =>
  formKind.value === "ssh" ? t("settings.credentials.form.usernamePlaceholderSsh") : t("settings.credentials.form.usernamePlaceholderHttps")
);

function credentialKindLabel(kind: CredentialKind) {
  return kind === "ssh" ? t("settings.credentials.form.kindSsh") : t("settings.credentials.form.kindHttps");
}

const credentialSecretLabel = computed(() => {
  if (formKind.value === "https") {
    return credentialModalMode.value === "create"
      ? t("settings.credentials.form.secretLabel.httpsCreate")
      : t("settings.credentials.form.secretLabel.httpsEdit");
  }
  return credentialModalMode.value === "create"
    ? t("settings.credentials.form.secretLabel.sshCreate")
    : t("settings.credentials.form.secretLabel.sshEdit");
});

function openCreateCredential() {
  credentialModalMode.value = "create";
  editingCredentialId.value = null;
  formHost.value = "";
  formKind.value = "https";
  formLabel.value = "";
  formUsername.value = "";
  formSecret.value = "";
  formIsDefault.value = false;
  generatedPublicKey.value = "";
  credentialModalOpen.value = true;
}

function openEditCredential(c: CredentialRecord) {
  credentialModalMode.value = "edit";
  editingCredentialId.value = c.id;
  formHost.value = c.host;
  formKind.value = c.kind;
  formLabel.value = c.label || "";
  formUsername.value = c.username || "";
  formSecret.value = "";
  formIsDefault.value = c.isDefault;
  generatedPublicKey.value = "";
  credentialModalOpen.value = true;
}

watch(
  () => formKind.value,
  (k) => {
    if (k !== "ssh") generatedPublicKey.value = "";
  }
);

const canSubmitCredential = computed(() => {
  if (credentialModalMode.value === "create") {
    if (!formHost.value.trim()) return false;
    if (!formSecret.value.trim()) return false;
  }
  return true;
});

async function generateSshKeypairWithUi() {
  if (sshKeypairGenerating.value) return;
  sshKeypairGenerating.value = true;
  try {
    const res = await generateSshKeypair();
    formSecret.value = res.privateKey;
    generatedPublicKey.value = res.publicKey;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    sshKeypairGenerating.value = false;
  }
}

async function copyGeneratedPublicKey() {
  const key = generatedPublicKey.value.trim();
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key);
    message.success(t("settings.credentials.copied"));
  } catch {
    message.error(t("settings.credentials.copyFailed"));
  }
}

async function submitCredential() {
  if (!canSubmitCredential.value) return;
  credentialSaving.value = true;
  try {
    if (credentialModalMode.value === "create") {
      await createCredential({
        host: formHost.value.trim(),
        kind: formKind.value,
        label: formLabel.value.trim() || undefined,
        username: formUsername.value.trim() || undefined,
        secret: formSecret.value,
        isDefault: formIsDefault.value
      });
    } else {
      const id = editingCredentialId.value;
      if (!id) return;
      await updateCredential(id, {
        label: formLabel.value.trim() || undefined,
        username: formUsername.value.trim() || undefined,
        isDefault: formIsDefault.value,
        secret: formSecret.value.trim() ? formSecret.value : undefined
      });
    }
    credentialModalOpen.value = false;
    generatedPublicKey.value = "";
    await refreshCredentials();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    credentialSaving.value = false;
  }
}

function confirmDeleteCredential(c: CredentialRecord) {
  Modal.confirm({
    title: t("settings.credentials.deleteConfirm.title"),
    content: t("settings.credentials.deleteConfirm.content"),
    okText: t("settings.credentials.deleteConfirm.ok"),
    okType: "danger",
    cancelText: t("settings.credentials.deleteConfirm.cancel"),
    onOk: async () => {
      await deleteCredential(c.id);
      await refreshCredentials();
    }
  });
}

const networkLoading = ref(false);
const networkSaving = ref(false);
const networkHttpProxy = ref("");
const networkHttpsProxy = ref("");
const networkNoProxy = ref("");
const networkCaPem = ref("");
const networkApplyToTerminal = ref(false);

async function refreshNetwork() {
  networkLoading.value = true;
  try {
    const res = await getNetworkSettings();
    networkHttpProxy.value = res.httpProxy || "";
    networkHttpsProxy.value = res.httpsProxy || "";
    networkNoProxy.value = res.noProxy || "";
    networkCaPem.value = res.caCertPem || "";
    networkApplyToTerminal.value = Boolean(res.applyToTerminal);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    networkLoading.value = false;
  }
}

async function saveNetwork() {
  if (networkSaving.value) return;
  networkSaving.value = true;
  try {
    await updateNetworkSettings({
      httpProxy: networkHttpProxy.value.trim() ? networkHttpProxy.value.trim() : null,
      httpsProxy: networkHttpsProxy.value.trim() ? networkHttpsProxy.value.trim() : null,
      noProxy: networkNoProxy.value.trim() ? networkNoProxy.value.trim() : null,
      caCertPem: networkCaPem.value ? networkCaPem.value : null,
      applyToTerminal: networkApplyToTerminal.value
    });
    message.success(t("settings.network.saved"));
    await refreshNetwork();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    networkSaving.value = false;
  }
}

const security = ref<SecurityStatus | null>(null);
const resetHost = ref("");
const resettingHost = ref(false);

async function refreshSecurity() {
  try {
    security.value = await getSecurityStatus();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function resetKnownHostWithUi() {
  const host = resetHost.value.trim();
  if (!host) return;
  Modal.confirm({
    title: t("settings.security.resetConfirm.title"),
    content: t("settings.security.resetConfirm.content"),
    okText: t("settings.security.resetConfirm.ok"),
    okType: "danger",
    cancelText: t("settings.security.resetConfirm.cancel"),
    onOk: async () => {
      resettingHost.value = true;
      try {
        await resetKnownHost({ host });
        message.success(t("settings.security.resetSuccess"));
        resetHost.value = "";
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        resettingHost.value = false;
      }
    }
  });
}

watch(
  () => innerKey.value,
  async (k) => {
    if (k === "gitIdentity") await refreshGitIdentity();
    else if (k === "credentials") await refreshCredentials();
    else if (k === "network") await refreshNetwork();
    else if (k === "security") await refreshSecurity();
  },
  { immediate: true }
);
</script>
