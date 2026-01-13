<template>
  <div class="min-h-screen flex items-center justify-center p-6 bg-[var(--app-bg)]">
    <a-card class="w-full max-w-[420px]" :title="t('auth.login.title')">
      <a-form layout="vertical">
        <a-form-item :label="t('auth.login.tokenLabel')" required>
          <a-input-password
            v-model:value="token"
            :placeholder="t('auth.login.tokenPlaceholder')"
            :disabled="submitting"
            @keyup.enter="submit"
          />
        </a-form-item>

        <div class="flex items-center justify-between gap-3">
          <a-checkbox v-model:checked="remember" :disabled="submitting">
            {{ t("auth.login.remember30d") }}
          </a-checkbox>
          <a-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
            {{ t("auth.login.submit") }}
          </a-button>
        </div>

        <div class="pt-3 text-xs text-[color:var(--text-tertiary)]">
          {{ t("auth.login.hint") }}
        </div>
      </a-form>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { login } from "../services/api";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();

const token = ref("");
const remember = ref(false);
const submitting = ref(false);

const canSubmit = computed(() => token.value.trim().length > 0 && !submitting.value);

async function submit() {
  const next = String(route.query.next || "/workspaces");
  const input = token.value.trim();
  if (!input) return;

  submitting.value = true;
  try {
    await login({ token: input, remember: remember.value });
    token.value = "";
    await router.replace(next.startsWith("/") ? next : "/workspaces");
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    submitting.value = false;
  }
}
</script>

