import { useEffect, useRef, useState } from "react";
import fragment from "./wordmark.frag?raw";
import styles from "./IdentitySetup.module.css";

/** Mobile's shader, scoped to the small logo; static artwork is the fallback. */
export function OnboardingWordmark() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
    });
    if (!gl) return;
    const shaders: WebGLShader[] = [];
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Wordmark shader unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Wordmark shader failed");
      return shader;
    };
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    let frame = 0;
    let disposed = false;
    const release = () => {
      cancelAnimationFrame(frame);
      for (const shader of shaders) gl.deleteShader(shader);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
    try {
      if (!program || !buffer || !texture)
        throw new Error("Wordmark resources unavailable");
      gl.attachShader(
        program,
        compile(
          gl.VERTEX_SHADER,
          "attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}",
        ),
      );
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("Wordmark link failed");
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const position = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } catch {
      release();
      return;
    }
    if (!program) return;
    const size = gl.getUniformLocation(program, "uSize");
    const phase = gl.getUniformLocation(program, "uPhase");
    const color = gl.getUniformLocation(program, "uColor");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const forced = matchMedia("(forced-colors: active)");
    const image = new Image();
    let loaded = false;
    const draw = (time: number) => {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round((width * 326) / 777));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const dark =
        canvas.closest("[data-color-mode]")?.getAttribute("data-color-mode") ===
        "dark";
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform2f(size, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(phase, (time % 400) / 400);
      gl.uniform4f(
        color,
        ...(dark
          ? ([0.95, 0.95, 0.95, 1] as const)
          : ([35 / 255, 30 / 255, 30 / 255, 1] as const)),
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frame = requestAnimationFrame(draw);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      const active =
        loaded &&
        !disposed &&
        !reduced.matches &&
        !forced.matches &&
        !document.hidden &&
        !gl.isContextLost();
      setAnimated(active);
      if (active) frame = requestAnimationFrame(draw);
    };
    image.onload = () => {
      if (disposed) return;
      // Normalize decoded image storage before uploading to WebKit's GPU texture.
      const source = document.createElement("canvas");
      source.width = image.naturalWidth;
      source.height = image.naturalHeight;
      const context = source.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source,
      );
      loaded = true;
      sync();
    };
    image.src = "/buzz-wordmark.png";
    reduced.addEventListener("change", sync);
    forced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    canvas.addEventListener("webglcontextlost", sync);
    return () => {
      disposed = true;
      image.onload = null;
      reduced.removeEventListener("change", sync);
      forced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      canvas.removeEventListener("webglcontextlost", sync);
      release();
    };
  }, []);
  return (
    <span
      className={styles.logoLayers}
      data-animated={animated}
      role="img"
      aria-label="Buzz"
    >
      <img src="/buzz-wordmark.png" alt="" width="777" height="326" />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        tabIndex={-1}
        style={{ visibility: animated ? "visible" : "hidden" }}
      />
    </span>
  );
}
