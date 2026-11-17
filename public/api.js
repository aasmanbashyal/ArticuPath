async function api(path, options={}) {
  const { body, ...rest } = options;
  const response = await fetch(`/api${path}`, { ...rest, ...(body instanceof Blob ? { body } :
    body ? { body:JSON.stringify(body), headers:{'Content-Type':'application/json'} } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The request failed (${response.status}).`);
  return data;
}

export { api };
