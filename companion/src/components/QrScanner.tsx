import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Camera QR scanning.
 *
 * Two decoders, in preference order. `BarcodeDetector` is native, hardware
 * accelerated and present on modern Android Chrome; jsQR is the fallback that
 * carries iOS Safari and everything older. The jsQR path deliberately samples
 * at a reduced resolution — full-resolution decoding on a mid-range phone costs
 * more per frame than it buys in read distance, and a stuttering preview makes
 * the code *harder* to line up.
 *
 * The camera is a shared, finite resource: every exit path here stops the
 * tracks, or the phone keeps the torch and the privacy indicator on after the
 * user has navigated away.
 */

type Props = {
  onResult: (text: string) => void;
  /** Rendered when the camera cannot be used at all, so the user isn't stuck. */
  onUnavailable?: (reason: string) => void;
};

const SCAN_INTERVAL_MS = 220;
const SAMPLE_WIDTH = 480;

type DetectorLike = { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };

function createNativeDetector(): DetectorLike | null {
  const Ctor = (
    window as unknown as {
      BarcodeDetector?: new (options: { formats: string[] }) => DetectorLike;
    }
  ).BarcodeDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

export function QrScanner({ onResult, onUnavailable }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const deliveredRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);

  const deliver = useCallback(
    (text: string) => {
      // Decoders happily return the same code every frame. The parent navigates
      // away on the first hit, so anything after that is noise at best and a
      // double-claim at worst.
      if (deliveredRef.current) return;
      deliveredRef.current = true;
      onResult(text);
    },
    [onResult]
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const detector = createNativeDetector();

    const stop = (): void => {
      if (timer) clearInterval(timer);
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      streamRef.current = null;
    };

    const scanFrame = async (): Promise<void> => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || deliveredRef.current) return;

      if (detector) {
        try {
          const codes = await detector.detect(video);
          const value = codes.find((c) => c.rawValue)?.rawValue;
          if (value) deliver(value);
          return;
        } catch {
          // Fall through to jsQR — some implementations throw on the first
          // frames rather than returning an empty list.
        }
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ratio = video.videoHeight / video.videoWidth || 1;
      canvas.width = SAMPLE_WIDTH;
      canvas.height = Math.round(SAMPLE_WIDTH * ratio);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
      if (found?.data) deliver(found.data);
    };

    const start = async (): Promise<void> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        const reason = "This browser can't open the camera. Enter the code by hand instead.";
        setError(reason);
        onUnavailable?.(reason);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
        setTorchAvailable(Boolean(capabilities?.torch));
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {
            /* autoplay policies; the user can tap the preview */
          });
        }
        timer = setInterval(() => void scanFrame(), SCAN_INTERVAL_MS);
      } catch (err) {
        const denied = err instanceof DOMException && err.name === "NotAllowedError";
        const reason = denied
          ? "Camera access was denied. Allow it in your browser settings, or enter the code by hand."
          : "Couldn't start the camera. Enter the code by hand instead.";
        setError(reason);
        onUnavailable?.(reason);
      }
    };

    void start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [deliver, onUnavailable]);

  async function toggleTorch(): Promise<void> {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  }

  if (error) {
    return (
      <div className="scanner scanner-error" role="status">
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="scanner">
      <video ref={videoRef} playsInline muted autoPlay aria-label="Camera preview" />
      <canvas ref={canvasRef} hidden />
      <div className="scanner-frame" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      {torchAvailable && (
        <button type="button" className="scanner-torch" onClick={() => void toggleTorch()}>
          {torchOn ? "Torch off" : "Torch on"}
        </button>
      )}
    </div>
  );
}
