<template>
  <a-modal
    v-model:open="openModel"
    :title="t('gitIdentity.modalTitle')"
    :confirm-loading="confirmLoading"
    :maskClosable="false"
    :okText="t('gitIdentity.actions.saveAndContinue')"
    :cancelText="t('gitIdentity.actions.cancel')"
    @ok="onOk"
  >
    <div v-if="statusLoading" class="text-xs text-[color:var(--text-tertiary)] pb-2">
      {{ t("common.loading") }}
    </div>
    <div v-else-if="status" class="text-xs text-[color:var(--text-tertiary)] pb-2">
      <span class="font-mono">{{ status.effective.source }}</span>
      <span v-if="status.effective.name && status.effective.email">
        · {{ status.effective.name }} &lt;{{ status.effective.email }}&gt;
      </span>
    </div>

    <a-form layout="vertical">
      <a-form-item :label="t('gitIdentity.form.nameLabel')" required>
        <a-input v-model:value="name" :placeholder="t('gitIdentity.form.namePlaceholder')" />
      </a-form-item>
      <a-form-item :label="t('gitIdentity.form.emailLabel')" required>
        <a-input v-model:value="email" :placeholder="t('gitIdentity.form.emailPlaceholder', { at: '@' })" />
      </a-form-item>

      <a-form-item :label="t('gitIdentity.form.scopeLabel')">
        <a-radio-group v-model:value="scope" button-style="solid">
          <a-radio-button v-if="allowSession" value="session">{{ t("gitIdentity.scope.session") }}</a-radio-button>
          <a-radio-button value="repo">{{ t("gitIdentity.scope.repo") }}</a-radio-button>
          <a-radio-button value="global">{{ t("gitIdentity.scope.global") }}</a-radio-button>
        </a-radio-group>
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<script setup lang="ts">
import type { GitIdentityInput, GitIdentityScope, GitIdentityStatus, GitTarget } from "@agent-workbench/shared";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { getWorkspaceGitIdentity } from "@/shared/api";

const props = defineProps<{
  open: boolean;
  target: GitTarget | null;
  allowSession?: boolean;
  defaultScope?: GitIdentityScope;
  loading?: boolean;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
  submit: [identity: GitIdentityInput];
}>();

const { t } = useI18n();

const openModel = computed({
  get: () => props.open,
  set: (v: boolean) => emit("update:open", v)
});

const allowSession = computed(() => props.allowSession !== false);
const submitting = ref(false);
const confirmLoading = computed(() => Boolean(props.loading) || submitting.value);

const statusLoading = ref(false);
const status = ref<GitIdentityStatus | null>(null);

const name = ref("");
const email = ref("");
const scope = ref<GitIdentityScope>(props.defaultScope ?? "repo");

async function refreshStatus() {
  if (!props.target) {
    status.value = null;
    return;
  }
  statusLoading.value = true;
  try {
    status.value = await getWorkspaceGitIdentity({ target: props.target });
    // 预填：优先 repo，其次 global
    const pick = (status.value.repo.name && status.value.repo.email ? status.value.repo : status.value.global) as any;
    if (pick?.name && pick?.email) {
      name.value = pick.name;
      email.value = pick.email;
    }
  } catch {
    status.value = null;
  } finally {
    statusLoading.value = false;
  }
}

watch(
  () => props.open,
  async (v) => {
    if (!v) return;
    submitting.value = false;
    scope.value = props.defaultScope ?? "repo";
    await refreshStatus();
  }
);

const canSubmit = computed(() => Boolean(name.value.trim() && email.value.trim()));

async function onOk() {
  if (!canSubmit.value) return;
  if (confirmLoading.value) return;
  submitting.value = true;
  try {
    emit("submit", { scope: scope.value, name: name.value.trim(), email: email.value.trim() });
  } finally {
    submitting.value = false;
  }
}
</script>
