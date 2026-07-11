<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { ApiError } from '../lib/api';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const password = ref('');
const name = ref('');
const email = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

async function submit(): Promise<void> {
  submitting.value = true;
  error.value = null;
  try {
    await auth.login({ password: password.value, name: name.value, email: email.value });
    const next = typeof route.query.next === 'string' ? route.query.next : '/workflows';
    await router.replace(next);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'could not sign in';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="login">
    <form class="card panel" @submit.prevent="submit">
      <div class="brand">
        <span class="eye" aria-hidden="true" />
        <span class="name">Argus</span>
      </div>
      <p class="muted lede">Fleet-wide governance for n8n. Sign in to continue.</p>

      <div class="field">
        <label for="pw">Admin password</label>
        <input id="pw" v-model="password" class="input" type="password" autocomplete="current-password" required>
      </div>
      <div class="field">
        <label for="nm">Your name</label>
        <input id="nm" v-model="name" class="input" type="text" autocomplete="name" placeholder="Sam Rivers" required>
      </div>
      <div class="field">
        <label for="em">Your email</label>
        <input id="em" v-model="email" class="input" type="email" autocomplete="email" placeholder="sam@acme.example" required>
        <span class="hint">Stamped on your session and every change you make — shown as <em>asserted</em>.</span>
      </div>

      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <button class="btn btn--primary btn--block" type="submit" :disabled="submitting">
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--spacing--lg);
}
.panel {
  width: 100%;
  max-width: 22rem;
  display: flex;
  flex-direction: column;
  gap: var(--spacing--sm);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing--xs);
}
.eye {
  width: var(--spacing--md);
  height: var(--spacing--md);
  border-radius: var(--radius--full);
  background: radial-gradient(circle at center, var(--color--neutral-white) 0 22%, var(--background--brand) 30% 100%);
  box-shadow: 0 0 0 2px var(--background--brand);
}
.name {
  font-size: var(--font-size--xl);
  font-weight: var(--font-weight--bold);
  letter-spacing: -0.01em;
}
.lede { font-size: var(--font-size--sm); margin: 0 0 var(--spacing--2xs); }
.err {
  margin: 0;
  color: var(--color--danger);
  font-size: var(--font-size--2xs);
}
</style>
