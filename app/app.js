(function(){
  const $ = (id) => document.getElementById(id);

  const dom = {
    canvas: $("imgresult"),
    stageWrap: $("stageWrap"),
    meta: $("meta"),
    fileInput: $("imger"),
    btnLoad: $("btnLoad"),
    btnSeed: $("btnSeed"),
    btnReset: $("btnReset"),
    btnDl: $("btnDl"),
    sliders: {
      seed: $("seed"),
      power: $("power"),
      dispx: $("dispx"),
      dispy: $("dispy"),
      chunk: $("chunk"),
      tear: $("tear"),
      rgb: $("rgb"),
      grain: $("grain"),
      blend: $("blend")
    },
    toggles: {
      block: $("blockToggle"),
      sort: $("sortToggle"),
      smear: $("smearToggle")
    }
  };

  const ctx = dom.canvas.getContext("2d", { willReadFrequently: true });

  const state = {
    baseFull: null,
    baseW: 0,
    baseH: 0,
    basePrev: null,
    prevW: 0,
    prevH: 0,
    workA: null,
    workB: null,
    smearBuf: null,
    isDragging: false,
    raf: 0
  };

  const sliderDefs = [
    ["seed", (v)=>String(Math.round(v))],
    ["power", (v)=>`${Math.round(v)}%`],
    ["dispx", (v)=>`${Math.round(v)}px`],
    ["dispy", (v)=>`${Math.round(v)}px`],
    ["chunk", (v)=>`${Math.round(v)}px`],
    ["tear", (v)=>`${Math.round(v)}%`],
    ["rgb", (v)=>`${Math.round(v)}px`],
    ["grain", (v)=>`${Math.round(v)}%`],
    ["blend", (v)=>`${Math.round(v)}%`]
  ];

  const MathFx = {
    clamp(v,a,b){ return v < a ? a : (v > b ? b : v); },
    hash2i(x, y, seed){
      let h = (x|0) * 374761393 + (y|0) * 668265263 + (seed|0) * 2147483647;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= (h >>> 16);
      return (h >>> 0) / 4294967296;
    },
    rint(a,b){ return (a + Math.floor(Math.random() * (b - a + 1)))|0; },
    rbool(){ return Math.random() < 0.5; }
  };

  const UI = {
    hasImage(){
      return !!state.baseFull;
    },
    syncVals(){
      for (const [id, fmt] of sliderDefs){
        const v = parseFloat($(id).value);
        $(id + "Value").textContent = fmt(v);
      }
    },
    updateCanvasPlaceholder(){
      dom.stageWrap.classList.toggle("empty", !UI.hasImage());
      document.body.classList.toggle("has-image", UI.hasImage());
    },
    setMeta(text){
      dom.meta.textContent = text;
    }
  };

  const Params = {
    get(){
      return {
        seed: parseInt(dom.sliders.seed.value, 10) | 0,
        power: parseFloat(dom.sliders.power.value) / 100,
        dispx: parseFloat(dom.sliders.dispx.value),
        dispy: parseFloat(dom.sliders.dispy.value),
        chunk: Math.max(2, parseInt(dom.sliders.chunk.value, 10) | 0),
        tear: parseFloat(dom.sliders.tear.value) / 100,
        rgb: parseFloat(dom.sliders.rgb.value),
        grain: parseFloat(dom.sliders.grain.value) / 100,
        blend: parseFloat(dom.sliders.blend.value) / 100,
        block: !!dom.toggles.block.checked,
        sort: !!dom.toggles.sort.checked,
        smear: !!dom.toggles.smear.checked
      };
    }
  };

  const PixelOps = {
    nearestRGB(pix, w, h, x, y){
      x = MathFx.clamp(x|0, 0, w-1);
      y = MathFx.clamp(y|0, 0, h-1);
      const i = (y*w + x) * 4;
      return [pix[i], pix[i+1], pix[i+2]];
    },
    blockShuffle(buf, w, h, approxTile, seed){
      const tile = MathFx.clamp(approxTile|0, 8, 64);
      const bx = Math.max(1, Math.floor(w / tile));
      const by = Math.max(1, Math.floor(h / tile));
      const total = bx * by;
      const ids = new Array(total);
      for (let i=0;i<total;i++) ids[i] = i;
      for (let i=total-1;i>0;i--){
        const r = MathFx.hash2i(i, 99, seed) * (i+1);
        const j = r|0;
        const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
      }
      const out = new Uint8ClampedArray(buf.length);
      out.set(buf);
      for (let idx=0; idx<total; idx++){
        const srcIdx = ids[idx];
        const sx = (srcIdx % bx) * tile;
        const sy = Math.floor(srcIdx / bx) * tile;
        const dx = (idx % bx) * tile;
        const dy = Math.floor(idx / bx) * tile;
        const bw = Math.min(tile, w - sx, w - dx);
        const bh = Math.min(tile, h - sy, h - dy);
        for (let y=0;y<bh;y++){
          const syy = sy + y;
          const dyy = dy + y;
          for (let x=0;x<bw;x++){
            const sxx = sx + x;
            const dxx = dx + x;
            const si = (syy*w + sxx)*4;
            const di = (dyy*w + dxx)*4;
            buf[di]   = out[si];
            buf[di+1] = out[si+1];
            buf[di+2] = out[si+2];
            buf[di+3] = out[si+3];
          }
        }
      }
    },
    pixelSortBands(buf, w, h, strength, seed){
      if (strength <= 0) return;
      const chance = MathFx.clamp(strength, 0, 1);
      const minLen = 8;
      const maxLen = Math.max(minLen+2, Math.floor(40 + 80*strength));
      const tmp = new Array(maxLen);
      for (let y=0;y<h;y++){
        let x = 0;
        while (x < w){
          const r = MathFx.hash2i(x, y, seed);
          if (r > chance){ x++; continue; }
          const segLen = MathFx.clamp(Math.floor(minLen + r * (maxLen-minLen)), minLen, maxLen);
          const end = Math.min(w, x + segLen);
          const len = end - x;
          for (let i=0;i<len;i++){
            const px = x + i;
            const idx = (y*w + px)*4;
            const R = buf[idx], G = buf[idx+1], B = buf[idx+2];
            const br = 0.3*R + 0.59*G + 0.11*B;
            tmp[i] = [br, idx];
          }
          tmp.slice(0, len).sort((a,b)=>a[0]-b[0]);
          for (let i=0;i<len;i++){
            const idxSrc = tmp[i][1];
            const px = x + i;
            const idxDst = (y*w + px)*4;
            buf[idxDst]   = buf[idxSrc];
            buf[idxDst+1] = buf[idxSrc+1];
            buf[idxDst+2] = buf[idxSrc+2];
            buf[idxDst+3] = 255;
          }
          x = end;
        }
      }
    }
  };

  const Engine = {
    drawToCanvas(pix, w, h){
      const img = new ImageData(pix, w, h);
      dom.canvas.width = w;
      dom.canvas.height = h;
      ctx.putImageData(img, 0, 0);
      UI.updateCanvasPlaceholder();
    },
    annihilateInto(basePix, w, h, outPix, tmpPix, time){
      const p = Params.get();
      const seed = p.seed;
      let baseUsed = basePix;

      if (p.smear && state.smearBuf && state.smearBuf.length === basePix.length){
        const a = 0.35 + 0.4 * p.power;
        for (let i=0;i<basePix.length;i+=4){
          const r = basePix[i]   * (1-a) + state.smearBuf[i]   * a;
          const g = basePix[i+1] * (1-a) + state.smearBuf[i+1] * a;
          const b = basePix[i+2] * (1-a) + state.smearBuf[i+2] * a;
          tmpPix[i]   = r;
          tmpPix[i+1] = g;
          tmpPix[i+2] = b;
          tmpPix[i+3] = 255;
        }
        baseUsed = tmpPix.slice(0);
      }

      tmpPix.set(baseUsed);
      const pow = p.power;
      const warpX = p.dispx * (0.35 + 1.35 * pow);
      const warpY = p.dispy * (0.35 + 1.35 * pow);
      const chunk = p.chunk;
      const passes = 1 + Math.floor(pow * 3);
      let read = tmpPix;
      let write = outPix;

      for (let pass = 0; pass < passes; pass++){
        const passSeed = seed + pass * 10007 + Math.floor(time * 12) * (pass === 0 ? 0 : 1);
        for (let y = 0; y < h; y++){
          let rowShift = 0;
          if (p.tear > 0){
            const band = (y / Math.max(1, Math.floor(6 + (1-pow)*24))) | 0;
            const r = MathFx.hash2i(band, pass, passSeed + 777);
            if (r < (0.15 + 0.55 * p.tear)){
              const dir = MathFx.hash2i(y, pass, passSeed + 1337) < 0.5 ? -1 : 1;
              const amp = (6 + 44 * p.tear) * (0.5 + MathFx.hash2i(y, 9, passSeed + 9));
              rowShift = dir * amp;
            }
          }
          for (let x = 0; x < w; x++){
            const cx = (x / chunk) | 0;
            const cy = (y / chunk) | 0;
            const n1 = MathFx.hash2i(cx, cy, passSeed);
            const n2 = MathFx.hash2i(cx + 41, cy - 17, passSeed + 909);
            const dx = (n1 - 0.5) * 2 * warpX;
            const dy = (n2 - 0.5) * 2 * warpY;
            const jitter = pow * 3.0;
            const jx = (MathFx.hash2i(x, y, passSeed + 2222) - 0.5) * 2 * jitter;
            const jy = (MathFx.hash2i(x, y, passSeed + 3333) - 0.5) * 2 * jitter;
            const sx = x + dx + rowShift + jx;
            const sy = y + dy + jy;
            const rgb = p.rgb * (0.2 + 0.95 * pow);
            const rS = PixelOps.nearestRGB(read, w, h, sx + rgb, sy);
            const gS = PixelOps.nearestRGB(read, w, h, sx, sy);
            const bS = PixelOps.nearestRGB(read, w, h, sx - rgb, sy);
            const i = (y*w + x) * 4;
            write[i]   = rS[0];
            write[i+1] = gS[1];
            write[i+2] = bS[2];
            write[i+3] = 255;
          }
        }
        const t = read; read = write; write = t;
      }

      let final = read;
      if (p.block) PixelOps.blockShuffle(final, w, h, p.chunk * (0.6 + 1.2*pow), seed + 5555);
      if (p.sort) PixelOps.pixelSortBands(final, w, h, 0.35 + 0.55*pow, seed + 7777);

      const blend = p.blend;
      const out = outPix;
      for (let y = 0; y < h; y++){
        for (let x = 0; x < w; x++){
          const i = (y*w + x) * 4;
          let r = baseUsed[i]   + (final[i]   - baseUsed[i])   * blend;
          let g = baseUsed[i+1] + (final[i+1] - baseUsed[i+1]) * blend;
          let b = baseUsed[i+2] + (final[i+2] - baseUsed[i+2]) * blend;
          if (p.grain > 0){
            const gn = (MathFx.hash2i(x, y, seed + (time*30)|0) - 0.5) * 2;
            const amp = (6 + 34 * p.grain) * (0.35 + 0.65 * pow);
            r += gn * amp; g += gn * amp; b += gn * amp;
          }
          out[i]   = MathFx.clamp(r, 0, 255);
          out[i+1] = MathFx.clamp(g, 0, 255);
          out[i+2] = MathFx.clamp(b, 0, 255);
          out[i+3] = 255;
        }
      }

      if (p.smear){
        if (!state.smearBuf || state.smearBuf.length !== out.length){
          state.smearBuf = new Uint8ClampedArray(out.length);
        }
        state.smearBuf.set(out);
      }
      return out;
    },
    ensureWorkBuffers(w,h){
      if (!state.workA || state.workA.length !== w*h*4){
        state.workA = new Uint8ClampedArray(w*h*4);
        state.workB = new Uint8ClampedArray(w*h*4);
      }
    },
    render(time=0){
      if (!state.baseFull) return;
      if (state.isDragging && state.basePrev){
        const w = state.prevW, h = state.prevH;
        Engine.ensureWorkBuffers(w,h);
        const out = Engine.annihilateInto(state.basePrev, w, h, state.workB, state.workA, time);
        Engine.drawToCanvas(out, w, h);
        return;
      }
      const w = state.baseW, h = state.baseH;
      Engine.ensureWorkBuffers(w,h);
      const out = Engine.annihilateInto(state.baseFull, w, h, state.workB, state.workA, time);
      Engine.drawToCanvas(out, w, h);
    },
    schedule(time=0){
      if (!state.baseFull || state.raf) return;
      state.raf = requestAnimationFrame(() => {
        state.raf = 0;
        Engine.render(time);
      });
    }
  };

  const ImageIO = {
    async loadFile(file){
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = URL.createObjectURL(file);
      });

      const MAX_W = 1400;
      const MAX_H = 1000;
      const s = Math.min(1, MAX_W / img.width, MAX_H / img.height);
      state.baseW = Math.max(1, Math.round(img.width * s));
      state.baseH = Math.max(1, Math.round(img.height * s));

      dom.canvas.width = state.baseW;
      dom.canvas.height = state.baseH;
      ctx.clearRect(0,0,state.baseW,state.baseH);
      ctx.drawImage(img, 0, 0, state.baseW, state.baseH);
      const full = ctx.getImageData(0,0,state.baseW,state.baseH);
      state.baseFull = new Uint8ClampedArray(full.data);
      state.smearBuf = null;

      const PREV_MAX = 720;
      const ps = Math.min(1, PREV_MAX / Math.max(state.baseW, state.baseH));
      state.prevW = Math.max(1, Math.round(state.baseW * ps));
      state.prevH = Math.max(1, Math.round(state.baseH * ps));

      const oldW = dom.canvas.width, oldH = dom.canvas.height;
      dom.canvas.width = state.prevW; dom.canvas.height = state.prevH;
      ctx.clearRect(0,0,state.prevW,state.prevH);
      ctx.drawImage(img, 0, 0, state.prevW, state.prevH);
      const prev = ctx.getImageData(0,0,state.prevW,state.prevH);
      state.basePrev = new Uint8ClampedArray(prev.data);
      dom.canvas.width = oldW; dom.canvas.height = oldH;

      UI.setMeta(`LOADED ${img.width}×${img.height} > ${state.baseW}×${state.baseH} (PREVIEW ${state.prevW}×${state.prevH})`);
      UI.updateCanvasPlaceholder();
      Engine.schedule(0);
    },
    downloadPng(){
      if (!UI.hasImage()){
        UI.setMeta("Load an image first.");
        UI.updateCanvasPlaceholder();
        return;
      }
      state.isDragging = false;
      Engine.render(0);
      const a = document.createElement("a");
      a.href = dom.canvas.toDataURL("image/png");
      a.download = "discombobulated.png";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  const Actions = {
    randomizeAll(){
      dom.sliders.seed.value = String(MathFx.rint(0, 99999));
      dom.sliders.power.value = String(MathFx.rint(25, 100));
      dom.sliders.dispx.value = String(MathFx.rint(0, 80));
      dom.sliders.dispy.value = String(MathFx.rint(0, 80));
      dom.sliders.chunk.value = String(MathFx.rint(2, 64));
      dom.sliders.tear.value = String(MathFx.rint(0, 100));
      dom.sliders.rgb.value = String(MathFx.rint(0, 30));
      dom.sliders.grain.value = String(MathFx.rint(0, 100));
      dom.sliders.blend.value = String(MathFx.rint(60, 100));
      dom.toggles.block.checked = MathFx.rbool();
      dom.toggles.sort.checked = MathFx.rbool();
      dom.toggles.smear.checked = MathFx.rbool();
      state.smearBuf = null;
      UI.syncVals();
      if (UI.hasImage()) Engine.render(0);
    },
    resetDefaults(){
      dom.sliders.seed.value = "1337";
      dom.sliders.power.value = "75";
      dom.sliders.dispx.value = "50";
      dom.sliders.dispy.value = "44";
      dom.sliders.chunk.value = "14";
      dom.sliders.tear.value = "55";
      dom.sliders.rgb.value = "10";
      dom.sliders.grain.value = "18";
      dom.sliders.blend.value = "100";
      dom.toggles.block.checked = false;
      dom.toggles.sort.checked = false;
      dom.toggles.smear.checked = false;
      state.smearBuf = null;
      UI.syncVals();
      if (UI.hasImage()) Engine.render(0);
      else{
        UI.setMeta("NO IMAGE LOADED");
        UI.updateCanvasPlaceholder();
      }
    }
  };

  const Events = {
    attachDragAware(input){
      input.addEventListener("pointerdown", () => { state.isDragging = true; Engine.schedule(0); });
      input.addEventListener("input", () => { UI.syncVals(); Engine.schedule(0); });
      input.addEventListener("change", () => { state.isDragging = false; UI.syncVals(); Engine.render(0); });
    },
    bind(){
      for (const [id] of sliderDefs) Events.attachDragAware($(id));
      window.addEventListener("pointerup", () => {
        if (!state.isDragging) return;
        state.isDragging = false;
        Engine.render(0);
      });
      window.addEventListener("pointercancel", () => {
        if (!state.isDragging) return;
        state.isDragging = false;
        Engine.render(0);
      });

      dom.toggles.block.addEventListener("change", () => Engine.render(0));
      dom.toggles.sort.addEventListener("change", () => Engine.render(0));
      dom.toggles.smear.addEventListener("change", () => Engine.render(0));

      dom.btnLoad.addEventListener("click", () => dom.fileInput.click());
      dom.fileInput.addEventListener("change", async () => {
        const f = dom.fileInput.files && dom.fileInput.files[0];
        if (!f) return;
        await ImageIO.loadFile(f);
        dom.fileInput.value = "";
      });

      dom.btnSeed.addEventListener("click", Actions.randomizeAll);
      dom.btnReset.addEventListener("click", Actions.resetDefaults);
      dom.btnDl.addEventListener("click", ImageIO.downloadPng);
    }
  };

  function init(){
    UI.syncVals();
    UI.updateCanvasPlaceholder();
    Events.bind();
  }

  init();
})();
