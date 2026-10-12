export const ENDPOINT = 'https://clever-moon-f3ca15b3.tunnl.gg/v1';
export const MODEL = 'oc/muse-spark-1.3-contributor-free';

export function buildHarnessPatch() {
  return [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      custom-muse:',
  '        displayName: Muse Spark custom gateway',
  '        apiKeyEnv: CUSTOM_API_KEY',
  '        api: openai-responses',
  '        baseURL: ' + ENDPOINT,
  '        reasoning: xhigh',
  '        models:',
  '          - id: ' + MODEL,
  '            name: Muse Spark 1.3 Contributor Free',
  '            contextWindow: 1048576',
  '            maxTokens: 131072',
  '            input: [text, image]',
  '            reasoningEfforts:',
  '              off:',
  '              low: low',
  '              medium: medium',
  '              high: high',
  '              xhigh: xhigh',
  '- id: agent-default-model',
  '  config:',
  '    provider: custom-muse',
  '    model: ' + MODEL,
  '    reasoningEffort: xhigh',
  ''
].join('\n');
}
