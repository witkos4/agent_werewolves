import { data, Form, redirect } from "react-router";

import {
  configuredKey,
  isAuthenticated,
  issueSession,
  keyMatches,
  sanitizeNext,
  sessionCookie,
} from "~/access.server";
import { cloudflareContext } from "~/cloudflare-context";

import type { Route } from "./+types/login";

const MISCONFIGURED = "The access gate is misconfigured: ACCESS_KEY is unset or too short.";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Sign in · Agent Werewolves" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const next = sanitizeNext(new URL(request.url).searchParams.get("next"));

  if (await isAuthenticated(request, env, Date.now())) throw redirect(next);
  return { next, misconfigured: configuredKey(env) === null };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const key = configuredKey(env);
  if (!key) return data({ error: MISCONFIGURED }, { status: 503 });

  const form = await request.formData();
  const given = form.get("key");
  if (typeof given !== "string" || !(await keyMatches(given, key))) {
    return data({ error: "Wrong access key." }, { status: 401 });
  }

  const next = sanitizeNext(form.get("next")?.toString());
  const secure = new URL(request.url).protocol === "https:";
  return redirect(next, {
    headers: { "Set-Cookie": sessionCookie(await issueSession(key, Date.now()), { secure }) },
  });
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const error = loaderData.misconfigured ? MISCONFIGURED : actionData?.error;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Agent Werewolves</h1>
      {/* A document POST, so no `.data` or `/__manifest` request has to pass the gate. */}
      <Form method="post" reloadDocument className="flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="next" value={loaderData.next} />
        <label htmlFor="key" className="text-gray-600 dark:text-gray-400">
          Access key
        </label>
        <input
          id="key"
          name="key"
          type="password"
          required
          autoComplete="current-password"
          autoFocus
          className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
        />
        <button
          type="submit"
          className="rounded-lg bg-gray-900 px-3 py-2 font-semibold text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
        >
          Sign in
        </button>
        {error && (
          <p role="alert" className="text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </Form>
    </main>
  );
}
