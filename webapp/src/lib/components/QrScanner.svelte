<script lang="ts">
  // Camera QR capture for device pairing.
  //
  // Two decoders, in preference order:
  //   1. BarcodeDetector — native, hardware-accelerated, no download. Chrome and
  //      Android have it; Safari and Firefox do not.
  //   2. jsQR — pure JS fallback, so iOS (where the phone being paired usually
  //      IS a Safari device) works at all.
  //
  // The camera is a convenience, never an authority: a scanned payload is
  // untrusted input that gets parsed and fingerprint-compared exactly like a
  // pasted one. Anyone can point a camera at anything.
  import jsQR from 'jsqr'
  import Icon from '../Icon.svelte'

  let {
    onscan,
    oncancel,
  }: { onscan: (text: string) => void; oncancel: () => void } = $props()

  let video: HTMLVideoElement | null = $state(null)
  let error = $state('')
  let starting = $state(true)

  let stream: MediaStream | null = null
  let raf = 0
  let stopped = false
  let canvas: HTMLCanvasElement | null = null

  interface DetectedBarcode {
    rawValue: string
  }
  interface BarcodeDetectorLike {
    detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
  }
  type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike

  async function makeNativeDetector(): Promise<BarcodeDetectorLike | null> {
    const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
    if (!Ctor) return null
    try {
      return new Ctor({ formats: ['qr_code'] })
    } catch {
      return null // present but refuses qr_code
    }
  }

  /** Read one frame into the scratch canvas, or null if the video isn't ready. */
  function grabFrame(): ImageData | null {
    if (!video || !video.videoWidth || !video.videoHeight) return null
    canvas ??= document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return ctx.getImageData(0, 0, canvas.width, canvas.height)
  }

  async function start() {
    try {
      // `environment` asks for the rear camera — you point a phone AT the other
      // screen. Browsers treat it as a hint, so a laptop still gets its webcam.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
    } catch (e) {
      // Denied, no camera, or a non-secure context (getUserMedia needs HTTPS or
      // localhost). Say so plainly — the paste box below still works.
      error =
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in your browser, or paste the code instead.'
          : 'No camera available here. Paste the code instead.'
      starting = false
      return
    }
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    if (video) {
      video.srcObject = stream
      await video.play().catch(() => {})
    }
    starting = false

    const native = await makeNativeDetector()

    const tick = async () => {
      if (stopped) return
      const frame = grabFrame()
      if (frame) {
        let text: string | null = null
        if (native && canvas) {
          try {
            const found = await native.detect(canvas)
            text = found[0]?.rawValue ?? null
          } catch {
            /* transient decode failure; try again next frame */
          }
        } else {
          const found = jsQR(frame.data, frame.width, frame.height)
          text = found?.data ?? null
        }
        if (text) {
          stop()
          onscan(text)
          return
        }
      }
      raf = requestAnimationFrame(() => void tick())
    }
    void tick()
  }

  function stop() {
    stopped = true
    if (raf) cancelAnimationFrame(raf)
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
  }

  $effect(() => {
    void start()
    return stop // release the camera when the scanner closes
  })
</script>

<div class="scanner">
  <div class="frame">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={video} playsinline muted></video>
    <div class="reticle" aria-hidden="true"></div>
    {#if starting}
      <p class="status">Starting camera…</p>
    {/if}
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else}
    <p class="hint">Point this at the QR code on the other device.</p>
  {/if}

  <button class="ghost" onclick={oncancel}>
    <Icon name="x" /> Cancel
  </button>
</div>

<style>
  .scanner {
    margin-top: 10px;
  }
  .frame {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    max-height: 320px;
    overflow: hidden;
    border-radius: var(--r-2, 8px);
    background: #000;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .reticle {
    position: absolute;
    inset: 18%;
    border: 2px solid rgb(255 255 255 / 0.85);
    border-radius: 12px;
    box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.35);
  }
  .status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    margin: 0;
    color: #fff;
    font-size: 13px;
  }
  .hint {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--text-3);
  }
  .error {
    margin: 8px 0 0;
    font-size: 13px;
    color: var(--danger, #dc2626);
  }
  .ghost {
    margin-top: 10px;
    width: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 14px;
    min-height: 44px;
    font: inherit;
    font-size: 13px;
    font-weight: 550;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    cursor: pointer;
  }
</style>
