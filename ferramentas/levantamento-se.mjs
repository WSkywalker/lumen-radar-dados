// Levantamento: quais municípios de Sergipe usam o Diário Oficial do "Município Online".
import { writeFile } from "node:fs/promises";
const UA = "LumenPlanRadar/1.0 (levantamento; +https://github.com/WSkywalker/lumen-radar-dados)";
const munis = await (await fetch("https://study-zen-planner-53.lovable.app/municipios.json")).json();
const se = munis.filter((m) => m[1] === "SE");
const slug = (n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ok = [], nao = [];
for (const m of se) {
  const s = slug(m[0]);
  try {
    const r = await fetch(`https://www.municipioonline.com.br/se/prefeitura/${s}/cidadao/diariooficial`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    if (r.ok && /Di[áa]rio Oficial Eletr[ôo]nico/i.test(t) && /ddlTipoPublicacao/.test(t)) ok.push(`${m[0]} (${s})`);
    else nao.push(`${m[0]}:${r.status}`);
  } catch (e) {
    nao.push(`${m[0]}:erro`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`SE com Município Online: ${ok.length}/${se.length}`);
console.log("SIM: " + ok.join(", "));
console.log("NAO: " + nao.join(", "));
await writeFile(new URL("../status-se.json", import.meta.url), JSON.stringify({ municipio_online: ok, sem: nao }, null, 1) + "\n");
