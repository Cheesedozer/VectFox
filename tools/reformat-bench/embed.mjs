const KEY = process.env.OPENROUTER_API_KEY;
export async function embed(texts, model = 'openai/text-embedding-3-small') {
    const out = [];
    for (let i = 0; i < texts.length; i += 100) {
        const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: texts.slice(i, i + 100) }),
        });
        const data = await res.json();
        if (!data.data) throw new Error(`embeddings failed: ${JSON.stringify(data).slice(0, 300)}`);
        out.push(...data.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
    }
    return out;
}
export function cosine(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let k = 0; k < a.length; k++) { d += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
    return d / Math.sqrt(na * nb);
}
