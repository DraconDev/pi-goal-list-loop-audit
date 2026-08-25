// Hermetic extension fixture for the detached-auditor allowlist check.
// It registers one offline model without network, credentials, or installation.
export default function auditorExtensionFixture(pi) {
  pi.registerProvider("glla-auditor-fixture", {
    name: "GLLA Auditor Fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "offline-fixture-key",
    api: "openai-completions",
    models: [{
      id: "fixture-model",
      name: "GLLA Auditor Fixture Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 512,
    }],
  });
}
