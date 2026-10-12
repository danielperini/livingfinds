import { Agent, run } from '@openai/agents';
import path from 'node:path';\nimport { pathToFileURL } from 'node:url';\nimport { inspectGithubActionsTool } from './tools/github.js';
import { inspectRuntimeConfigurationTool, inspectVpsHealthTool } from './tools/diagnostics.js';
import { proposePatchTool, readRepositoryFileTool } from './tools/repository.js';
import { runAllowlistedTestsTool } from './tools/tests.js';

export const LIVINGFINDS_ENGINEER_INSTRUCTIONS = `
Você é o Principal Engineer assistente do Living Finds, hospedado em VPS Hostinger.
Conheça o contexto: frontend React/Vite; serviços Node/Deno; camadas legadas de compatibilidade em base44/; Amazon Ads e SP-API; motor determinístico V6SIA; OpenAI e Claude; schedulers, relatórios, finanças, reconciliação, GitHub Actions e observabilidade.

Diagnostique ponta a ponta usando evidências: fonte e atualização do dado, persistência, transformação/cálculo, configuração efetiva, decisão, guardrails, execução, confirmação remota, interface e auditoria. Distingua confirmado, provável e desconhecido. Cite caminho/função e proponha testes concretos. Nunca invente números, não prometa vendas/lucro e não trate requisição enviada como confirmação.

Você pode somente ler arquivos permitidos, executar suítes fixas, inspecionar as últimas 10 Actions, checar health público/configuração por presença e propor diffs não aplicados. Use ferramentas quando necessário e informe escopo/limites do resultado.

Não solicite, revele, copie ou registre secrets. Você não tem autorização nem ferramenta para alterar campanhas Amazon, lances, orçamento, keywords, banco, estoque, credenciais, branch main ou VPS; não crie comandos para contornar esses limites. Não faça deploy. Sugestões financeiras devem respeitar os dados disponíveis, as configurações efetivas e os limites determinísticos do motor; a IA não substitui esses controles nem garante rentabilidade.
`.trim();

export function createLivingFindsEngineer() {
  return new Agent({
    name: 'Living Finds Principal Engineer',
    instructions: LIVINGFINDS_ENGINEER_INSTRUCTIONS,
    model: process.env.LIVINGFINDS_ENGINEER_MODEL || 'gpt-6-luna',
    tools: [
      readRepositoryFileTool,
      proposePatchTool,
      runAllowlistedTestsTool,
      inspectGithubActionsTool,
      inspectVpsHealthTool,
      inspectRuntimeConfigurationTool,
    ],
  });
}

export async function analyzeWithLivingFindsEngineer(task) {
  if (!process.env.OPENAI_API_KEY) {
    return { status: 'not_configured', reason: 'OPENAI_API_KEY não configurada no processo; nenhuma chamada foi feita.' };
  }
  const agent = createLivingFindsEngineer();
  const result = await run(agent, String(task || '').slice(0, 12000), {
    maxTurns: 8,
    traceIncludeSensitiveData: false,
  });
  return {
    status: 'analysis_only',
    model: process.env.LIVINGFINDS_ENGINEER_MODEL || 'gpt-6-luna',
    final_output: result.finalOutput ?? '',
    tools_available: agent.tools.map((item) => item.name),
    mutations_performed: false,
  };
}

async function readTaskFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const input = process.argv.slice(2).join(' ') || await readTaskFromStdin();
  try {
    const result = await analyzeWithLivingFindsEngineer(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'not_configured') process.exitCode = 2;
  } catch {
    process.stderr.write('Falha na análise do agente. Consulte logs do serviço sem registrar prompts ou credenciais.\n');
    process.exitCode = 1;
  }
}
