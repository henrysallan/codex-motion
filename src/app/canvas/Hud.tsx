// Performance overlay (toggle with `): renderer stats and the M0 benchmark.

import { Gauge, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, IconButton } from '../../ui/controls.tsx';
import { engine, engineState } from '../engine.ts';
import { runBench, summarize } from './bench.ts';
import type { BoardController } from './BoardController.ts';

const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;
const ms = (v: number) => v.toFixed(1);

export function Hud({ ctrl, onClose }: { ctrl: BoardController; onClose: () => void }) {
  const [, tick] = useState(0);
  const [report, setReport] = useState<{ lines: string[]; pass: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [budget, setBudget] = useState(engineState.stats?.budget ?? 24);
  const [tiers, setTiers] = useState(false);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);

  const s = engineState.stats;
  const bench = async () => {
    setRunning(true);
    setReport(null);
    try {
      const summary = summarize(await runBench(ctrl));
      console.info(summary.lines.join('\n'));
      setReport(summary);
    } finally {
      setRunning(false);
    }
  };

  return (
    <aside className="hud">
      <header>
        <Gauge size={15} />
        <strong>Renderer</strong>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>
      <pre>
        {s
          ? [
              `${s.fps.toFixed(0).padStart(3)} fps  display ${s.refreshHz.toFixed(0)} Hz`,
              `frame p50 ${ms(s.frameP50)}  p95 ${ms(s.frameP95)}  max ${ms(s.frameMax)}`,
              `cpu ${ms(s.cpuMs)} ms   drops ${s.drops}/120`,
              `visible ${s.visible}  L0 ${s.tiers[0]}  L1 ${s.tiers[1]}  L2 ${s.tiers[2]}`,
              `decoders ${s.decoders} (${s.decodersL2} L2)  budget ${s.budget}`,
              `waiting ${s.streamsWaiting}  late ${(s.lateRatio * 100).toFixed(1)}%${s.failed ? `  failed ${s.failed}` : ''}`,
              `sprites ${s.l0Resident}/${s.l0Total}  atlas ${s.atlasLayers}L ${mb(s.l0Bytes)}`,
            ].join('\n')
          : 'starting…'}
      </pre>
      <label className="hud-row">
        decoders
        <input
          type="range"
          min={0}
          max={64}
          value={budget}
          onChange={(e) => {
            setBudget(Number(e.target.value));
            engine.setSettings({ decoderBudget: Number(e.target.value) });
          }}
        />
        <output>{budget}</output>
      </label>
      <label className="hud-row">
        <input
          type="checkbox"
          checked={tiers}
          onChange={(e) => {
            setTiers(e.target.checked);
            engine.setSettings({ showTiers: e.target.checked });
          }}
        />
        tier outlines
      </label>
      <Button size="sm" onClick={bench} disabled={running}>
        {running ? 'Running…' : 'Run benchmark'}
      </Button>
      {engineState.gpu && <p className="hud-gpu">{engineState.gpu.adapter} · {engineState.gpu.atlasFormat}</p>}
      {report && (
        <pre className={`hud-report ${report.pass ? 'pass' : ''}`} onClick={() => setReport(null)}>
          {report.lines.join('\n')}
        </pre>
      )}
    </aside>
  );
}
