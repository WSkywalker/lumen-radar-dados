// Junta o concursos.json desta execução com o que já está no repositório,
// sem apagar o trabalho de outra execução que terminou antes.
// Uso: node ferramentas/mesclar.mjs <nosso.json> <remoto.json> <prefixos separados por vírgula>
// Para os prefixos indicados (fontes coletadas nesta execução) vale a versão nossa;
// para as demais fontes, vale a versão do repositório.
import { readFile, writeFile } from "node:fs/promises";

const [nossoArq, remotoArq, prefixosTxt] = process.argv.slice(2);
const nosso = JSON.parse(await readFile(nossoArq, "utf8"));
let remoto = { itens: [] };
try {
  remoto = JSON.parse(await readFile(remotoArq, "utf8"));
} catch {
  /* sem arquivo remoto */
}
const prefixos = String(prefixosTxt ?? "").split(",").map((p) => p.trim()).filter(Boolean);
const nossaFonte = (id) => prefixos.some((p) => id.startsWith(p));
const itens = [
  ...nosso.itens.filter((i) => nossaFonte(i.id)),
  ...remoto.itens.filter((i) => !nossaFonte(i.id)),
].sort((a, b) => String(b.publicado_em).localeCompare(String(a.publicado_em)));
await writeFile(remotoArq, JSON.stringify({ ...nosso, total: itens.length, itens }, null, 1) + "\n");
console.log(`mesclado: ${itens.length} itens (fontes desta execução: ${prefixos.join(", ")})`);
