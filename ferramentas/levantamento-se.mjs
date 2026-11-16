// Levantamento das fontes de Sergipe: robots.txt, se responde, se tem busca/API.
import { writeFile } from "node:fs/promises";
const UA = "LumenPlanRadar/1.0 (levantamento; +https://github.com/WSkywalker/lumen-radar-dados)";
const FONTES = {
  "DOE-SE (IOSE)": "https://www.iose.se.gov.br/",
  "DOE-SE busca": "https://www.iose.se.gov.br/buscanova/",
  "Município Online (SE)": "https://www.municipioonline.com.br/se/prefeitura/simaodias",
  "DOM Aracaju": "https://www.aracaju.se.gov.br/",
  "Querido Diário Aracaju": "https://api.queridodiario.org.br/gazettes?territory_ids=2800308&size=1",
};
const out = {};
for (const [nome, url] of Object.entries(FONTES)) {
  const r = {};
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(25000) });
    const t = await res.text();
    r.status = res.status; r.final = res.url;
    r.titulo = t.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim()?.slice(0, 120) ?? null;
    r.busca = /pesquis|busca|search/i.test(t);
    r.api = [...new Set((t.match(/\/(api|apifront|busca)[\w\/.-]{2,60}/g) ?? []))].slice(0, 12);
    r.links_diario = [...new Set((t.match(/href="[^"]*(diario|edic|publica)[^"]*"/gi) ?? []))].slice(0, 15);
    const rob = await fetch(new URL("/robots.txt", res.url), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    r.robots = rob.ok ? (await rob.text()).slice(0, 400) : `sem robots (${rob.status})`;
  } catch (e) {
    r.erro = String(e?.cause?.code ?? e?.name ?? e);
  }
  out[nome] = r;
  console.log(nome, JSON.stringify(r).slice(0, 900));
}
await writeFile(new URL("../status-se.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
