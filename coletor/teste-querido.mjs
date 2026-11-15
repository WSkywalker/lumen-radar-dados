// Teste de disponibilidade da API pública do Querido Diário (diários municipais).
// Grava o resultado em status-querido.json. Não altera concursos.json.
import { writeFile } from "node:fs/promises";

const Q = "gazettes?querystring=%22concurso%20p%C3%BAblico%22&published_since=2026-11-01&size=3&excerpt_size=300&number_of_excerpts=1";
// endereço da documentação em texto e endereço que aparece no exemplo (imagem) do tutorial
const ENDERECOS = [
  "https://api.queridodiario.org.br/", // domínio novo (sem ".ok")
  "https://queridodiario.org.br/api/",
  "https://api.queridodiario.ok.org.br/",
  "https://queridodiario.ok.org.br/api/",
];
const resultados = [];
for (const base of ENDERECOS) {
const URL_TESTE = base + Q;
const out = { testado_em: new Date().toISOString(), url: URL_TESTE };
try {
  const r = await fetch(URL_TESTE, { headers: { "User-Agent": "LumenPlanRadar/1.0" } });
  out.status = r.status;
  const t = await r.text();
  try {
    const j = JSON.parse(t);
    out.total = j.total_gazettes;
    out.exemplos = (j.gazettes ?? []).slice(0, 3).map((g) => ({
      cidade: g.territory_name, uf: g.state_code, data: g.date, url: g.url, trecho: (g.excerpts ?? [])[0]?.slice(0, 300),
    }));
  } catch {
    out.corpo = t.slice(0, 500);
  }
} catch (e) {
  out.erro = String(e?.cause?.code ?? e);
}
resultados.push(out);
}
console.log(JSON.stringify(resultados, null, 1));
await writeFile(new URL("../status-querido.json", import.meta.url), JSON.stringify(resultados, null, 1) + "\n");
