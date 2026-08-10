"use client";

/**
 * 홈 지도 위의 **막** — 흐르는 라임 그라디언트 (디자이너 요청 2026-08-11).
 *
 * 지도와 인사말·입력창 사이에 있던 막은 평평한 베이지 방사형 그라디언트였다.
 * 디자이너가 참조로 준 시안(soqhomore/nodi-web-test의 `CanvasBackground`)의
 * **색·움직임·요소**를 그대로 옮겨 온다.
 *
 * ⚠️ **막의 성질은 안 바꾼다.** 저쪽 시안에서 이 그림은 지도 **뒤에 깔리는
 * 배경**이라 불투명하지만, 우리 화면에서 이것은 지도 **위에 얹히는 막**이다.
 * 그래서 부르는 쪽이 투명도를 쥐고(0.66), 포인터도 그대로 통과시킨다 —
 * 막이 포인터를 먹으면 배경은 그림이 되고 지도를 둘 이유가 사라진다.
 *
 * WebGL을 못 쓰는 환경에서는 **아무것도 안 그린다**. 막은 장식이므로 여기서
 * 실패해도 화면은 그대로 쓸 수 있어야 한다(원본과 같은 태도).
 */

import { useEffect, useRef } from "react";

/**
 * 셰이더에 넘길 색 넷. 시안의 `BACKGROUND_SHADER_COLORS` 그대로다.
 *
 * **순서에 의미가 있다** — 1·2가 아래층, 3·4가 위층이 되어 오버레이로
 * 합성되므로 밝은 크림에서 진한 라임 순으로 늘어놓는다.
 */
const VEIL_COLORS = {
  color1: "#FDFDE7", // 크림
  color2: "#E4FF8C", // 연한 라임
  color3: "#CEFF04", // 라임
  color4: "#92FF04", // 진한 라임
} as const;

const VERTEX_SHADER = `
  attribute vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  uniform vec2 iResolution;
  uniform float iTime;

  uniform vec3 uColor1;
  uniform vec3 uColor2;
  uniform vec3 uColor3;
  uniform vec3 uColor4;

  #define S(a,b,t) smoothstep(a,b,t)

  mat2 Rot(float a) {
    float s = sin(a);
    float c = cos(a);
    return mat2(c, -s, s, c);
  }

  vec2 hash(vec2 p) {
    p = vec2(dot(p, vec2(2127.1, 81.17)), dot(p, vec2(1269.5, 283.37)));
    return fract(sin(p) * 43758.5453);
  }

  float noise(in vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float n = mix(
      mix(dot(-1.0 + 2.0 * hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
          dot(-1.0 + 2.0 * hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
      mix(dot(-1.0 + 2.0 * hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
          dot(-1.0 + 2.0 * hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
      u.y);
    return 0.5 + 0.5 * n;
  }

  // 포토샵의 오버레이와 같은 식. 아래층이 어두우면 곱하고, 밝으면 스크린한다.
  float overlayChannel(float base, float blend) {
    return base < 0.5
      ? (2.0 * base * blend)
      : (1.0 - 2.0 * (1.0 - base) * (1.0 - blend));
  }

  vec3 overlayBlend(vec3 base, vec3 blend) {
    return vec3(
      overlayChannel(base.r, blend.r),
      overlayChannel(base.g, blend.g),
      overlayChannel(base.b, blend.b)
    );
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / iResolution.xy;
    float ratio = iResolution.x / iResolution.y;

    vec2 tuv = uv - 0.5;

    float degree = noise(vec2(iTime * 0.1, tuv.x * tuv.y));

    tuv.y *= 1.0 / ratio;
    tuv *= Rot(radians((degree - 0.5) * 720.0 + 180.0));
    tuv.y *= ratio;

    float frequency = 5.0;
    float amplitude = 30.0;
    float speed = iTime * 2.0;

    tuv.x += sin(tuv.y * frequency + speed) / amplitude;
    tuv.y += sin(tuv.x * frequency * 1.5 + speed) / (amplitude * 0.5);

    float sweep = (tuv * Rot(radians(-5.0))).x;
    vec3 layer1 = mix(uColor1, uColor2, S(-0.3, 0.2, sweep));
    vec3 layer2 = mix(uColor3, uColor4, S(-0.3, 0.2, sweep));

    // 두 레이어를 오버레이로 합성한다. 아래로 갈수록 위층이 더 실린다.
    vec3 blended = overlayBlend(layer1, layer2);
    vec3 finalComp = mix(layer1, blended, S(0.5, -0.3, tuv.y));

    gl_FragColor = vec4(finalComp, 1.0);
  }
`;

function hexToRgb(hex: string): [number, number, number] {
  let c = hex.replace(/^#/, "");
  if (c.length === 3) {
    c = c
      .split("")
      .map((x) => x + x)
      .join("");
  }
  const num = parseInt(c, 16);
  return [(num >> 16) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

function compileShader(
  gl: WebGLRenderingContext,
  source: string,
  type: number,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("막 셰이더 컴파일 실패:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function VeilShader({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", { antialias: false });
    if (!gl) return;

    const vertexShader = compileShader(gl, VERTEX_SHADER, gl.VERTEX_SHADER);
    const fragmentShader = compileShader(gl, FRAGMENT_SHADER, gl.FRAGMENT_SHADER);
    if (!vertexShader || !fragmentShader) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("막 셰이더 링크 실패:", gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const iResolutionLocation = gl.getUniformLocation(program, "iResolution");
    const iTimeLocation = gl.getUniformLocation(program, "iTime");

    gl.uniform3fv(gl.getUniformLocation(program, "uColor1"), hexToRgb(VEIL_COLORS.color1));
    gl.uniform3fv(gl.getUniformLocation(program, "uColor2"), hexToRgb(VEIL_COLORS.color2));
    gl.uniform3fv(gl.getUniformLocation(program, "uColor3"), hexToRgb(VEIL_COLORS.color3));
    gl.uniform3fv(gl.getUniformLocation(program, "uColor4"), hexToRgb(VEIL_COLORS.color4));

    /**
     * **절반 해상도로 그린다** (2026-08-11).
     *
     * 원본은 dpr(최대 2배)로 그렸다. 저쪽에서는 이 그림이 화면 전체의 배경
     * 하나뿐이지만, 우리 홈에서는 **개념 지도가 같은 화면에서 매 프레임
     * 돌고 있다** — 노드가 많은 계정에서도 렉이 없어야 한다는 것이 이 화면의
     * 전제다(사용자 지시 2026-08-10).
     *
     * 실측(소프트웨어 GL, 헤드리스): 막을 넣기 전 56fps → dpr로 그리면 33fps.
     * 막은 경계가 없는 부드러운 그라디언트라 절반으로 그려도 **보이는 그림이
     * 달라지지 않는다** — CSS가 늘려 주고, 늘어나면서 오히려 더 부드럽다.
     */
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * 0.5));
      canvas.height = Math.max(1, Math.round(rect.height * 0.5));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(iResolutionLocation, canvas.width, canvas.height);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    /**
     * 교실에서 쓰는 화면이다. 움직임을 줄여 달라고 한 사용자에게는 애니메이션
     * 대신 정지한 한 장만 보여 준다(원본과 같다).
     */
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let frame = 0;
    const draw = (timeMs: number) => {
      gl.uniform1f(iTimeLocation, timeMs * 0.001);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const loop = (timeMs: number) => {
      draw(timeMs);
      frame = requestAnimationFrame(loop);
    };

    if (reduceMotion.matches) {
      draw(0);
    } else {
      frame = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, []);

  /**
   * ⚠️ **바닥색을 깔아 둔다.** WebGL을 못 쓰는 기기에서는 캔버스가 투명한
   * 채로 남아 **막이 통째로 사라진다** — 인사말과 입력창이 붐비는 지도 위에
   * 그냥 얹히고, 이 막을 둔 이유가 없어진다. 옛 막은 순수 CSS라 언제나
   * 있었으니 그 보장을 잃지 않는다.
   *
   * 색은 시안 팔레트의 가장 밝은 크림이다(베이지로 되돌리지 않는다). 셰이더가
   * 돌면 그 위를 불투명하게 덮으므로 보이는 그림은 안 달라진다.
   */
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`block size-full ${className}`}
      style={{ background: VEIL_COLORS.color1 }}
    />
  );
}
