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
    <div v-if="status" class="text-xs text-[color:var(--text-tertiary)] pb-2">
      <span class="font-mono">{{ status.effective.source }}</span>
      <span v-if="status.effective.name && status.effective.email">
        · {{ status.effective.name }} &lt;{{ status.effective.email }}&gt;
      </span>
    </div>

    <a-form layout="vertical">
      <a-form-item :label="t('gitIdentity.form.nameLabel')" required>
        <a-input ref="nameInputRef" v-model:value="name" :placeholder="t('gitIdentity.form.namePlaceholder')" />
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
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
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
const statusLoading = ref(false);
const confirmLoading = computed(() => Boolean(props.loading) || submitting.value || statusLoading.value);
const status = ref<GitIdentityStatus | null>(null);

type SimpleInputRef = { focus?: () => void; select?: () => void };

const nameInputRef = ref<SimpleInputRef | null>(null);
const name = ref("");
const email = ref("");
const scope = ref<GitIdentityScope>(props.defaultScope ?? "repo");

let dialogSeq = 0;
let statusRequestSeq = 0;
let disposed = false;
const targetKey = (target: GitTarget | null) => target ? `${target.workspaceId}/${target.dirName}` : "";

async function refreshStatus(dialog = dialogSeq) {
  const request = ++statusRequestSeq;
  const target = props.target ? { ...props.target } : null;
  const isCurrent = () => !disposed && props.open && dialog === dialogSeq && request === statusRequestSeq && targetKey(target) === targetKey(props.target);
  if (!target || !props.open) return;
  statusLoading.value = true;
  try {
    const next = await getWorkspaceGitIdentity({ target });
    if (!isCurrent()) return;
    status.value = next;
    // 预填：优先 repo，其次 global，不让旧弹窗或旧目标的响应回写。
    const pick = next.repo.name && next.repo.email ? next.repo : next.global;
    if (pick.name && pick.email) {
      name.value = pick.name;
      email.value = pick.email;
    }
  } catch {
    if (isCurrent()) status.value = null;
  } finally {
    if (isCurrent()) statusLoading.value = false;
  }
}

watch(
  [() => props.open, () => targetKey(props.target)],
  async () => {
    const dialog = ++dialogSeq;
    statusRequestSeq += 1;
    submitting.value = false;
    statusLoading.value = false;
    status.value = null;
    name.value = "";
    email.value = "";
    scope.value = props.defaultScope ?? "repo";
    if (!props.open) return;
    await refreshStatus(dialog);
    await nextTick();
    if (!disposed && props.open && dialog === dialogSeq) nameInputRef.value?.focus?.();
  },
  { immediate: true, flush: "sync" }
);

onBeforeUnmount(() => {
  disposed = true;
  dialogSeq += 1;
  statusRequestSeq += 1;
});

const canSubmit = computed(() => Boolean(name.value.trim() && email.value.trim()));

function onOk() {
  if (!props.open || !canSubmit.value || confirmLoading.value) return;
  const dialog = dialogSeq;
  submitting.value = true;
  // 保存由父层处理；submit 同步发出，不在旧保存完成后再读取新弹窗的内容。
  emit("submit", { scope: scope.value, name: name.value.trim(), email: email.value.trim() });
  void nextTick(() => {
    if (!disposed && dialog === dialogSeq) submitting.value = false;
  });
}
</script>
