export async function getJson<T>(url: string, parser: (value: unknown) => T) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return parser(await response.json());
}

export async function postJson<T>(url: string, payload: unknown, parser: (value: unknown) => T) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(async () => ({ error: await response.text() }));
    throw new Error(typeof errorBody.error === "string" ? errorBody.error : "Request failed");
  }

  return parser(await response.json());
}

export async function deleteRequest(url: string) {
  const response = await fetch(url, {
    method: "DELETE",
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(async () => ({ error: await response.text() }));
    throw new Error(typeof errorBody.error === "string" ? errorBody.error : "Request failed");
  }
}

export function formatError(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}
