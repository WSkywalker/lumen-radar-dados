// Junta as fontes: quando um concurso já tem edital (DOU ou banca), o aviso
// "banca contratada" do PNCP para o mesmo órgão deixa de aparecer.
import { readFile, writeFile } from "node:fs/promises";
import { cargoValido, limpaOrgao } from "./limpeza.mjs";

const ARQUIVO = new URL("../concursos.json", import.meta.url);
const norm = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const PALAVRAS_FRACAS = new Set(["de", "do", "da", "dos", "das", "e", "estado", "municipal", "prefeitura", "camara", "secretaria", "o", "a"]);
const chave = (orgao) =>
  norm(orgao)
    .split(" ")
    .filter((w) => w.length > 2 && !PALAVRAS_FRACAS.has(w))
    .sort()
    .join(" ");

const base = JSON.parse(await readFile(ARQUIVO, "utf8"));

// nomes do PNCP: acentos, UF no fim e cargo que é só o nome do órgão (vale também para itens antigos)
let limpos = 0;
for (const i of base.itens) {
  if (!i.id.startsWith("pncp:")) continue;
  const o = limpaOrgao(i.orgao);
  const c = cargoValido(i.cargo) ? i.cargo : "Cargos a definir (banca contratada)";
  if (o !== i.orgao || c !== i.cargo) limpos++;
  i.orgao = o;
  i.cargo = c;
}
if (limpos) console.log(`consolidação: ${limpos} nome(s) do PNCP limpos`);
const comEdital = base.itens.filter((i) => !i.id.startsWith("pncp:") && i.situacao !== "banca_contratada");
const mesmo = (p, e) =>
  p.uf && p.uf === e.uf &&
  ((p.cidade && e.cidade && norm(p.cidade) === norm(e.cidade) && norm(p.orgao).split(" ")[0] === norm(e.orgao).split(" ")[0]) ||
    (chave(p.orgao) && chave(p.orgao) === chave(e.orgao)));

let removidos = 0;
const itens = base.itens.filter((i) => {
  if (!i.id.startsWith("pncp:")) return true;
  const dup = comEdital.some((e) => mesmo(i, e) && String(e.publicado_em ?? "") >= String(i.publicado_em ?? ""));
  if (dup) removidos++;
  return !dup;
});
await writeFile(ARQUIVO, JSON.stringify({ ...base, total: itens.length, itens }, null, 1) + "\n");
console.log(`consolidação: ${removidos} aviso(s) de banca contratada substituído(s) por edital`);
