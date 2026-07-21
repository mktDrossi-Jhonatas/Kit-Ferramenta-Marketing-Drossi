import { useState, useRef, useCallback, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import JSZip from 'jszip';

// ─── Types ───────────────────────────────────────────────────────────────────
type ItemStatus = 'wait' | 'running' | 'done' | 'skip' | 'error';

interface QueueItem {
  id: string;
  file: File;
  status: ItemStatus;
  progress: number;
  origSize: number;
  finalSize?: number;
  resultBlob?: Blob;
  resultName?: string;
  metaText: string;
  errorMsg?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtMB(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(v.duration); };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não foi possível ler metadados')); };
    v.src = url;
  });
}

// ─── Badge ───────────────────────────────────────────────────────────────────
function Badge({ status }: { status: ItemStatus }) {
  const map: Record<ItemStatus, { cls: string; label: string }> = {
    wait:    { cls: 'border-white/20 text-white/40',        label: 'na fila' },
    running: { cls: 'border-yellow-400 text-yellow-400',    label: 'processando' },
    done:    { cls: 'border-green-400 text-green-400',      label: 'concluído' },
    skip:    { cls: 'border-blue-400 text-blue-400',        label: 'já ok' },
    error:   { cls: 'border-red-400 text-red-400',          label: 'erro' },
  };
  const { cls, label } = map[status];
  return (
    <span className={`font-mono text-[11px] px-2.5 py-0.5 rounded-full border whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

// ─── QueueRow ─────────────────────────────────────────────────────────────────
function QueueRow({
  item,
  onDownload,
}: {
  item: QueueItem;
  onDownload: (item: QueueItem) => void;
}) {
  return (
    <div className="bg-[#202325] border border-white/[0.07] rounded-xl p-3.5 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span
          className="text-[13.5px] font-medium truncate max-w-xs"
          title={item.file.name}
        >
          {item.file.name}
        </span>
        <Badge status={item.status} />
      </div>

      {/* Progress bar */}
      <div className="h-[5px] bg-black/40 rounded-full overflow-hidden">
        <div
          className="h-full bg-[#ee4d2d] rounded-full transition-all duration-200"
          style={{ width: `${item.progress}%` }}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="font-mono text-[11.5px] text-white/50">{item.metaText}</span>
        {item.resultBlob && (
          <button
            onClick={() => onDownload(item)}
            className="font-mono text-[12px] text-[#ee4d2d] border-b border-dotted border-[#ee4d2d] hover:opacity-70 transition-opacity"
          >
            baixar
          </button>
        )}
      </div>

      {item.errorMsg && (
        <p className="text-[11.5px] text-red-400 font-mono">{item.errorMsg}</p>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [engineStatus, setEngineStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [engineMsg, setEngineMsg] = useState(
    'Motor de compressão ainda não carregado — será baixado (uma vez) ao iniciar.'
  );
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [targetMB, setTargetMB] = useState(28);
  const [allDone, setAllDone] = useState(false);
  const [zipping, setZipping] = useState(false);

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const ffmpegReadyRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);

  // Keep processingRef in sync
  useEffect(() => { processingRef.current = processing; }, [processing]);

  // ── Update a single item ──────────────────────────────────────────────────
  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));
  }, []);

  // ── Load FFmpeg ───────────────────────────────────────────────────────────
  const ensureFFmpeg = useCallback(async () => {
    if (ffmpegReadyRef.current) return;
    setEngineStatus('loading');
    setEngineMsg('Carregando motor de compressão (ffmpeg.wasm)… isso acontece só uma vez.');

    try {
      const ff = new FFmpeg();
      ffmpegRef.current = ff;

      // Use unpkg CDN with toBlobURL so it loads cross-origin safely
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      await ff.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });

      ffmpegReadyRef.current = true;
      setEngineStatus('ready');
      setEngineMsg('✓ Motor carregado. Pronto para comprimir.');
    } catch (err: unknown) {
      setEngineStatus('error');
      const msg = err instanceof Error ? err.message : String(err);
      setEngineMsg('Falha ao carregar motor: ' + msg);
      throw err;
    }
  }, []);

  // ── Add files ────────────────────────────────────────────────────────────
  const addFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(f => f.type.startsWith('video/'));
    if (!files.length) return;

    const newItems: QueueItem[] = files.map(file => ({
      id: 'f' + Math.random().toString(36).slice(2),
      file,
      status: 'wait',
      progress: 0,
      origSize: file.size,
      metaText: fmtMB(file.size) + ' original',
    }));

    setItems(prev => [...prev, ...newItems]);
    setAllDone(false);
  }, []);

  // ── Process single item ───────────────────────────────────────────────────
  const processItem = useCallback(async (item: QueueItem, targetBytes: number) => {
    const ff = ffmpegRef.current!;
    const { id, file } = item;

    updateItem(id, { status: 'running', progress: 2 });

    try {
      const duration = await getVideoDuration(file);

      // Already within limit — skip re-encoding
      if (file.size <= targetBytes) {
        updateItem(id, {
          status: 'skip',
          progress: 100,
          resultBlob: file,
          resultName: file.name,
          finalSize: file.size,
          metaText: `${fmtMB(file.size)} — sem recompressão necessária`,
        });
        return;
      }

      // Calculate bitrates
      const audioKbps = 96; // lower audio saves bits for video
      const totalKbps = (targetBytes * 8) / duration / 1000;
      const videoKbps = Math.max(Math.round(totalKbps - audioKbps), 100);

      const ext = (file.name.split('.').pop() ?? 'mp4').toLowerCase();
      const inName = `in_${id}.${ext}`;
      const outName = `out_${id}.mp4`;

      // Write file to ffmpeg VFS
      updateItem(id, { metaText: 'Carregando vídeo…', progress: 5 });
      await ff.writeFile(inName, await fetchFile(file));

      // Progress handler
      const onProgress = ({ progress }: { progress: number }) => {
        const pct = Math.min(Math.round(5 + progress * 90), 95);
        updateItem(id, {
          progress: pct,
          metaText: `Comprimindo… ${pct}% · alvo ${videoKbps} kbps vídeo`,
        });
      };
      ff.on('progress', onProgress);

      // Run FFmpeg — ultrafast preset for maximum speed
      await ff.exec([
        '-i', inName,
        '-c:v', 'libx264',
        '-b:v', `${videoKbps}k`,
        '-maxrate', `${Math.round(videoKbps * 1.3)}k`,
        '-bufsize', `${videoKbps * 2}k`,
        '-preset', 'ultrafast',   // ← fastest encode, much quicker than veryfast
        '-tune', 'fastdecode',
        '-c:a', 'aac',
        '-b:a', `${audioKbps}k`,
        '-ac', '2',              // force stereo (reduces overhead)
        '-movflags', '+faststart',
        '-y', outName,
      ]);

      ff.off('progress', onProgress);

      // Read result
      const data = await ff.readFile(outName);
      // ffmpeg readFile returns Uint8Array; copy to plain ArrayBuffer to avoid SharedArrayBuffer issues
      const rawArr = data instanceof Uint8Array ? data : new Uint8Array(data as unknown as ArrayBuffer);
      const plainBuf = rawArr.buffer.slice(rawArr.byteOffset, rawArr.byteOffset + rawArr.byteLength) as ArrayBuffer;
      const blob = new Blob([plainBuf], { type: 'video/mp4' });

      // Cleanup VFS
      try { await ff.deleteFile(inName); } catch { /* ignore */ }
      try { await ff.deleteFile(outName); } catch { /* ignore */ }

      const baseName = file.name.replace(/\.[^.]+$/, '');
      const overLimit = blob.size > targetBytes * 1.05;

      updateItem(id, {
        status: 'done',
        progress: 100,
        resultBlob: blob,
        resultName: baseName + '_comprimido.mp4',
        finalSize: blob.size,
        metaText: overLimit
          ? `${fmtMB(file.size)} → ${fmtMB(blob.size)} ⚠ acima do limite (vídeo muito longo)`
          : `${fmtMB(file.size)} → ${fmtMB(blob.size)}`,
      });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateItem(id, {
        status: 'error',
        progress: 0,
        metaText: 'Erro ao processar',
        errorMsg: msg,
      });
    }
  }, [updateItem]);

  // ── Start all ─────────────────────────────────────────────────────────────
  const startAll = useCallback(async () => {
    if (processingRef.current) return;
    setProcessing(true);
    setAllDone(false);

    try {
      await ensureFFmpeg();
    } catch {
      setProcessing(false);
      return;
    }

    const targetBytes = targetMB * 1024 * 1024;
    const snapshot = items.filter(i => i.status === 'wait');

    for (const item of snapshot) {
      await processItem(item, targetBytes);
    }

    setProcessing(false);
    setAllDone(true);
  }, [items, targetMB, ensureFFmpeg, processItem]);

  // ── Download single ───────────────────────────────────────────────────────
  const downloadItem = useCallback((item: QueueItem) => {
    if (!item.resultBlob) return;
    const url = URL.createObjectURL(item.resultBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.resultName ?? 'video.mp4';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, []);

  // ── Download all as ZIP ───────────────────────────────────────────────────
  const downloadZip = useCallback(async () => {
    setZipping(true);
    const zip = new JSZip();
    items.filter(i => i.resultBlob).forEach(i => zip.file(i.resultName!, i.resultBlob!));
    const content = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'videos_comprimidos.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setZipping(false);
  }, [items]);

  // ── Clear ────────────────────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    setItems([]);
    setAllDone(false);
  }, []);

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const doneCount = items.filter(i => i.status === 'done' || i.status === 'skip').length;
  const readyToDownload = items.filter(i => i.resultBlob);
  const waitingCount = items.filter(i => i.status === 'wait').length;

  const engineColor =
    engineStatus === 'ready' ? 'text-green-400' :
    engineStatus === 'loading' ? 'text-yellow-400' :
    engineStatus === 'error' ? 'text-red-400' :
    'text-white/40';

  return (
    <div
      style={{ background: '#111315', color: '#f2f1ec', fontFamily: "'Inter', sans-serif" }}
      className="min-h-screen"
    >
      <div className="max-w-[920px] mx-auto px-6 py-10 pb-20">

        {/* Header */}
        <p className="font-mono text-xs tracking-widest text-[#ee4d2d] uppercase mb-2.5">
          Ferramenta local · nada sai do seu navegador
        </p>
        <h1 style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          className="text-3xl font-bold tracking-tight mb-2">
          Compressor em Massa
        </h1>
        <p className="text-white/50 text-[15px] leading-relaxed mb-8 max-w-xl">
          Envie vários vídeos de uma vez e receba cada um comprimido para caber no limite da Shopee.
          Todo o processamento roda dentro do seu navegador — nenhum arquivo é enviado a servidor nenhum.
        </p>

        {/* Settings + Drop */}
        <div className="bg-[#1a1d1f] border border-white/[0.08] rounded-2xl p-6 mb-5">

          {/* Target size + hint */}
          <div className="flex flex-wrap gap-6 items-start mb-5">
            <div>
              <label className="font-mono text-[11px] tracking-wider text-white/40 uppercase block mb-1.5">
                Tamanho máximo (MB)
              </label>
              <input
                type="number"
                value={targetMB}
                onChange={e => setTargetMB(Math.min(30, Math.max(5, Number(e.target.value))))}
                min={5} max={30} step={1}
                className="font-mono text-sm rounded-lg px-3 py-2 w-24"
                style={{
                  background: '#202325',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#f2f1ec',
                  outline: 'none',
                }}
                onFocus={e => (e.target.style.outline = '2px solid #ee4d2d')}
                onBlur={e => (e.target.style.outline = 'none')}
              />
            </div>
            <p className="text-white/40 text-[12.5px] leading-relaxed max-w-xs mt-0.5">
              Limite oficial da Shopee é 30&nbsp;MB. Deixamos{' '}
              <strong className="text-white/70">28&nbsp;MB</strong> como padrão para uma margem
              de segurança — o container sempre adiciona um pouco de overhead.
            </p>
          </div>

          {/* Drop zone */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={onDragOver}
            onDragEnter={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className="rounded-xl border-[1.5px] border-dashed text-center py-10 px-5 cursor-pointer transition-all duration-150"
            style={{
              borderColor: dragging ? '#ee4d2d' : 'rgba(255,255,255,0.12)',
              background: dragging ? 'rgba(238,77,45,0.05)' : 'transparent',
            }}
          >
            <p style={{ fontFamily: "'Space Grotesk', sans-serif" }}
              className="text-[17px] font-semibold mb-1.5">
              Arraste os vídeos aqui, ou clique para escolher
            </p>
            <p className="text-white/40 text-[13px]">
              Aceita vários arquivos · MP4, MOV, WEBM, MKV, AVI…
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              multiple
              className="hidden"
              onChange={e => e.target.files && addFiles(e.target.files)}
            />
          </div>

          {/* Engine status */}
          <p className={`font-mono text-[12.5px] mt-3.5 ${engineColor}`}>
            {engineMsg}
          </p>
        </div>

        {/* Queue panel */}
        {items.length > 0 && (
          <div className="bg-[#1a1d1f] border border-white/[0.08] rounded-2xl p-6">

            {/* Queue header */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
              <span className="font-mono text-[12.5px] text-white/50">
                {items.length} vídeo(s) · {doneCount} concluído(s)
                {waitingCount > 0 && ` · ${waitingCount} aguardando`}
              </span>
              <div className="flex gap-2.5">
                <button
                  onClick={clearAll}
                  disabled={processing}
                  className="text-[13.5px] font-semibold rounded-lg px-4 py-2.5 border border-white/10 text-white/70 hover:border-[#ee4d2d] hover:text-[#ee4d2d] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ fontFamily: "'Space Grotesk', sans-serif", background: 'transparent' }}
                >
                  Limpar fila
                </button>
                <button
                  onClick={startAll}
                  disabled={processing || waitingCount === 0}
                  className="text-[13.5px] font-semibold rounded-lg px-4 py-2.5 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    fontFamily: "'Space Grotesk', sans-serif",
                    background: processing || waitingCount === 0 ? '#3a3d3f' : '#ee4d2d',
                  }}
                >
                  {processing ? 'Processando…' : 'Comprimir tudo'}
                </button>
              </div>
            </div>

            {/* Performance tip */}
            {!processing && waitingCount > 0 && (
              <div className="mb-4 bg-yellow-400/5 border border-yellow-400/20 rounded-lg px-4 py-3">
                <p className="text-yellow-400/80 text-[12px] font-mono">
                  ⚡ Dica: o processamento roda no seu CPU, via WebAssembly. Velocidade depende do hardware.
                  Vídeos curtos terminam rápido; vídeos longos podem levar alguns minutos cada.
                </p>
              </div>
            )}

            {/* Items */}
            <div className="flex flex-col gap-2.5">
              {items.map(item => (
                <QueueRow key={item.id} item={item} onDownload={downloadItem} />
              ))}
            </div>

            {/* Download all */}
            {allDone && readyToDownload.length > 0 && (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 pt-5 border-t border-white/[0.07]">
                <span className="font-mono text-[12.5px] text-white/50">
                  {readyToDownload.length} arquivo(s) prontos
                </span>
                <button
                  onClick={downloadZip}
                  disabled={zipping}
                  className="text-[13.5px] font-semibold rounded-lg px-5 py-2.5 text-white transition-all disabled:opacity-50"
                  style={{ fontFamily: "'Space Grotesk', sans-serif", background: '#ee4d2d' }}
                >
                  {zipping ? 'Gerando ZIP…' : `Baixar todos (.zip)`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Explanation */}
        <div className="mt-7 border-t border-white/[0.07] pt-5 text-[12.5px] text-white/40 leading-relaxed space-y-2">
          <p>
            <strong className="text-white/70">Como funciona:</strong> medimos a duração de cada vídeo e
            calculamos o bitrate necessário para o arquivo caber no limite. Recodificamos com H.264 + AAC,
            usando o preset <strong className="text-white/70">ultrafast</strong> — muito mais rápido que o
            original (que usava <em>veryfast</em>). Vídeos já dentro do limite não são recodificados.
          </p>
          <p>
            <strong className="text-white/70">Por que demora?</strong> O ffmpeg.wasm roda em WebAssembly —
            é fundamentalmente mais lento que o ffmpeg nativo (cerca de 5–10× mais lento). Um vídeo de 1
            minuto pode levar de 30 segundos a 3 minutos dependendo do seu CPU. Não há como contornar isso
            sem um servidor. Mantenha a aba aberta durante o processamento.
          </p>
          <p>
            <strong className="text-white/70">Aviso:</strong> como o processamento é 100% local, dezenas
            de vídeos podem levar bastante tempo. Processe em lotes menores se necessário.
          </p>
        </div>

      </div>
    </div>
  );
}
