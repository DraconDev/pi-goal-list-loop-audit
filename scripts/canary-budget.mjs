/** Provider request guard used only by the opt-in real-host canary.
 * Unknown output-cap formats or missing price metadata fail before sending. */
export function createCanaryBudget({ maxUsd = 0.1, maxOutputTokens = 32, maxPayloadBytes = 8192 } = {}) {
  if (!(maxUsd > 0 && maxUsd <= 1) || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 64
    || !Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 256 || maxPayloadBytes > 16384) throw new Error("invalid canary budget");
  let requests = 0;
  return (payload, model) => {
    if (requests) throw new Error("canary permits exactly one provider request; retries are refused");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("unknown provider request payload");
    const capped = structuredClone(payload);
    const capFields = ["max_output_tokens", "max_completion_tokens", "max_tokens"].filter(key => Object.hasOwn(capped, key));
    const google = capped.generationConfig && Object.hasOwn(capped.generationConfig, "maxOutputTokens");
    if (!capFields.length && !google) throw new Error("provider output-token cap format is unsupported; no request sent");
    for (const key of capFields) capped[key] = Math.min(maxOutputTokens, Number.isFinite(capped[key]) && capped[key] > 0 ? capped[key] : maxOutputTokens);
    if (google) capped.generationConfig.maxOutputTokens = maxOutputTokens;
    // GLLA is loaded to exercise real host activation; this one-word
    // canary cannot invoke any of its tools or begin an agent loop.
    if (Object.hasOwn(capped, "tools")) capped.tools = [];
    delete capped.tool_choice;
    delete capped.parallel_tool_calls;
    const bytes = Buffer.byteLength(JSON.stringify(capped));
    if (bytes > maxPayloadBytes) throw new Error(`canary payload exceeds ${maxPayloadBytes} bytes; no request sent`);
    const inputPrice = model?.cost?.input;
    const outputPrice = model?.cost?.output;
    if (![inputPrice, outputPrice].every(price => Number.isFinite(price) && price >= 0)) throw new Error("canary needs model price metadata; no request sent");
    // Conservative byte/token allowance plus protocol overhead. This is a
    // metadata-based spend estimate, not a provider billing guarantee.
    const estimate = ((maxPayloadBytes + 4096) * inputPrice + maxOutputTokens * outputPrice) / 1_000_000;
    if (estimate > maxUsd) throw new Error(`canary estimated ceiling ${estimate} exceeds budget ${maxUsd}; no request sent`);
    requests++;
    return capped;
  };
}
