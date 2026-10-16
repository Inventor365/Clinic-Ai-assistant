/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Calendar,
  Clock,
  User,
  Phone,
  FileText,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Sparkles,
  Info,
  ShieldCheck,
  X,
  Volume2
} from 'lucide-react';

interface BookingConfirmation {
  referenceId: string;
  name: string;
  phone: string;
  day: string;
  date: string;
  time: string;
  reason: string;
}

interface TranscriptItem {
  id: string;
  role: 'asha' | 'user';
  text: string;
  timestamp: string;
}

export default function App() {
  const [callState, setCallState] = useState<'idle' | 'connecting' | 'connected'>('idle');
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [booking, setBooking] = useState<BookingConfirmation | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [isAshaSpeaking, setIsAshaSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  // Audio & WebSocket refs
  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const timerIntervalRef = useRef<any>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const ashaSilenceTimerRef = useRef<any>(null);

  // Local user time info
  const [localInfo, setLocalInfo] = useState({
    timeZone: '',
    todayStr: '',
    tomorrowStr: '',
    timeStr: '',
  });

  useEffect(() => {
    const updateLocalTime = () => {
      const now = new Date();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      const dateOptions: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      };
      const todayStr = now.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
      const timeStr = now.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });

      setLocalInfo({
        timeZone,
        todayStr,
        tomorrowStr,
        timeStr,
      });
    };

    updateLocalTime();
    const interval = setInterval(updateLocalTime, 60000);
    return () => clearInterval(interval);
  }, []);

  // Auto scroll transcript to bottom
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [transcripts]);

  // Call duration counter
  useEffect(() => {
    if (callState === 'connected') {
      setCallDuration(0);
      timerIntervalRef.current = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      setCallDuration(0);
    }
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [callState]);

  // Format call duration MM:SS
  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Resample input audio buffer to 16kHz linear PCM base64
  const resampleAndEncodePCM = (
    inputBuffer: Float32Array,
    inputSampleRate: number,
    targetSampleRate = 16000
  ): string => {
    let samples: Float32Array;
    if (inputSampleRate === targetSampleRate) {
      samples = inputBuffer;
    } else {
      const ratio = inputSampleRate / targetSampleRate;
      const targetLength = Math.round(inputBuffer.length / ratio);
      samples = new Float32Array(targetLength);
      for (let i = 0; i < targetLength; i++) {
        const srcIndex = i * ratio;
        const low = Math.floor(srcIndex);
        const high = Math.min(low + 1, inputBuffer.length - 1);
        const weight = srcIndex - low;
        samples[i] = inputBuffer[low] * (1 - weight) + inputBuffer[high] * weight;
      }
    }

    const int16Array = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    let binary = '';
    const bytes = new Uint8Array(int16Array.buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  // Gapless 24kHz PCM Playback
  const playPcmChunk = (base64Audio: string) => {
    const outputCtx = outputAudioCtxRef.current;
    if (!outputCtx || outputCtx.state === 'closed') return;

    if (outputCtx.state === 'suspended') {
      outputCtx.resume();
    }

    try {
      const binary = atob(base64Audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      const audioBuffer = outputCtx.createBuffer(1, float32Array.length, 24000);
      audioBuffer.getChannelData(0).set(float32Array);

      const source = outputCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputCtx.destination);

      const now = outputCtx.currentTime;
      if (nextPlayTimeRef.current < now) {
        nextPlayTimeRef.current = now + 0.035; // gentle jitter buffer
      }

      source.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += audioBuffer.duration;

      activeSourcesRef.current.add(source);
      setIsAshaSpeaking(true);

      if (ashaSilenceTimerRef.current) {
        clearTimeout(ashaSilenceTimerRef.current);
      }

      source.onended = () => {
        activeSourcesRef.current.delete(source);
        if (activeSourcesRef.current.size === 0) {
          ashaSilenceTimerRef.current = setTimeout(() => {
            setIsAshaSpeaking(false);
          }, 200);
        }
      };
    } catch (err) {
      console.error('Error decoding/playing PCM audio chunk:', err);
    }
  };

  // Stop playback instantly on interruption
  const stopAllPlayback = () => {
    activeSourcesRef.current.forEach((src) => {
      try {
        src.stop();
        src.disconnect();
      } catch (e) {}
    });
    activeSourcesRef.current.clear();
    nextPlayTimeRef.current = 0;
    setIsAshaSpeaking(false);
  };

  // Disconnect call completely
  const hangupCall = () => {
    // 1. Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // 2. Stop audio capture
    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
      } catch (e) {}
      scriptProcessorRef.current = null;
    }

    if (inputAudioCtxRef.current) {
      try {
        inputAudioCtxRef.current.close();
      } catch (e) {}
      inputAudioCtxRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    // 3. Stop audio playback
    stopAllPlayback();
    if (outputAudioCtxRef.current) {
      try {
        outputAudioCtxRef.current.close();
      } catch (e) {}
      outputAudioCtxRef.current = null;
    }

    setIsUserSpeaking(false);
    setIsAshaSpeaking(false);
    setCallState('idle');
  };

  // Start Call
  const startCall = async () => {
    setErrorMessage(null);
    setCallState('connecting');

    try {
      // 1. Request microphone permission
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // 2. Initialize Input AudioContext
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioCtx();
      await inputCtx.resume();
      inputAudioCtxRef.current = inputCtx;

      // 3. Initialize Output AudioContext at 24kHz for native Gemini Live audio
      const outputCtx = new AudioCtx({ sampleRate: 24000 });
      await outputCtx.resume();
      outputAudioCtxRef.current = outputCtx;
      nextPlayTimeRef.current = 0;

      // 4. Connect WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/live`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send init message with local time reference
        const now = new Date();
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
        const fullDateOptions: Intl.DateTimeFormatOptions = {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        };
        const todayStr = now.toLocaleDateString(undefined, fullDateOptions);
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString(undefined, fullDateOptions);
        const timeStr = now.toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        });

        ws.send(
          JSON.stringify({
            type: 'init',
            clientTime: `${todayStr} at ${timeStr}`,
            timeZone,
            today: todayStr,
            tomorrow: tomorrowStr,
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'session_ready') {
            setCallState('connected');
          } else if (data.type === 'audio') {
            playPcmChunk(data.audio);
          } else if (data.type === 'interrupted') {
            stopAllPlayback();
          } else if (data.type === 'transcript') {
            const role = data.role as 'asha' | 'user';
            const textChunk = data.text;
            const nowTime = new Date().toLocaleTimeString(undefined, {
              hour: 'numeric',
              minute: '2-digit',
            });

            setTranscripts((prev) => {
              if (prev.length > 0 && prev[prev.length - 1].role === role) {
                const updated = [...prev];
                const lastItem = updated[updated.length - 1];
                updated[updated.length - 1] = {
                  ...lastItem,
                  text: (lastItem.text + ' ' + textChunk).trim(),
                };
                return updated;
              } else {
                return [
                  ...prev,
                  {
                    id: `${Date.now()}-${Math.random()}`,
                    role,
                    text: textChunk.trim(),
                    timestamp: nowTime,
                  },
                ];
              }
            });
          } else if (data.type === 'booking_confirmed') {
            setBooking(data.booking);
          } else if (data.type === 'error') {
            setErrorMessage(data.message || 'An error occurred during the call.');
            hangupCall();
          }
        } catch (err) {
          console.error('Error handling WebSocket message:', err);
        }
      };

      ws.onerror = (evt) => {
        console.error('WebSocket connection error:', evt);
        setErrorMessage('Failed to connect to the clinic receptionist service.');
        hangupCall();
      };

      ws.onclose = () => {
        hangupCall();
      };

      // 5. Connect microphone stream to script processor for 16kHz audio chunks
      const micSource = inputCtx.createMediaStreamSource(stream);
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const channelData = e.inputBuffer.getChannelData(0);

        // Simple volume threshold to detect user speaking
        let sum = 0;
        for (let i = 0; i < channelData.length; i++) {
          sum += Math.abs(channelData[i]);
        }
        const avg = sum / channelData.length;
        setIsUserSpeaking(avg > 0.025);

        // Resample and convert to 16kHz linear PCM base64
        const base64Audio = resampleAndEncodePCM(channelData, inputCtx.sampleRate, 16000);
        ws.send(
          JSON.stringify({
            type: 'audio',
            audio: base64Audio,
          })
        );
      };

      micSource.connect(processor);
      processor.connect(inputCtx.destination);
    } catch (err: any) {
      console.error('Microphone setup error:', err);
      let errorMsg = 'Could not access your microphone.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMsg = 'Microphone permission was denied. Please allow microphone access to talk with Asha.';
      } else if (err.name === 'NotFoundError') {
        errorMsg = 'No microphone device was detected on your system.';
      }
      setErrorMessage(errorMsg);
      hangupCall();
    }
  };

  // Toggle button click
  const handleToggleCall = () => {
    if (callState === 'idle') {
      startCall();
    } else {
      hangupCall();
    }
  };

  // Copy booking summary to clipboard
  const handleCopyBooking = () => {
    if (!booking) return;
    const text = `Sunrise Clinic Appointment Confirmation (Demo)
Reference ID: ${booking.referenceId}
Patient: ${booking.name}
Phone: ${booking.phone}
Date & Time: ${booking.day}, ${booking.date} at ${booking.time}
Reason: ${booking.reason}`;

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-teal-500/30 selection:text-teal-200">
      {/* Top Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-teal-500 to-emerald-400 flex items-center justify-center shadow-lg shadow-teal-500/20 text-slate-950 font-bold">
              <Sparkles className="w-5 h-5 text-slate-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">Sunrise Clinic</h1>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 uppercase tracking-wider">
                  Demo
                </span>
              </div>
              <p className="text-xs text-slate-400">Receptionist Desk • Asha (AI Voice)</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Local time badge */}
            <div className="hidden sm:flex flex-col items-end text-right">
              <span className="text-xs font-medium text-slate-300">
                {localInfo.todayStr ? localInfo.todayStr.split(',')[0] : 'Today'}, {localInfo.timeStr}
              </span>
              <span className="text-[11px] text-slate-500 truncate max-w-[150px]">
                {localInfo.timeZone || 'Local time'}
              </span>
            </div>

            {/* Call status badge */}
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                callState === 'connected'
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                  : callState === 'connecting'
                  ? 'bg-amber-500/10 text-amber-300 border-amber-500/30 animate-pulse'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  callState === 'connected'
                    ? 'bg-emerald-400 shadow-sm shadow-emerald-400 animate-ping'
                    : callState === 'connecting'
                    ? 'bg-amber-400'
                    : 'bg-slate-500'
                }`}
              />
              {callState === 'connected'
                ? `In Call • ${formatDuration(callDuration)}`
                : callState === 'connecting'
                ? 'Connecting...'
                : 'Ready to Call'}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-6">
        {/* Error Alert Message */}
        {errorMessage && (
          <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-200 flex items-start justify-between gap-3 shadow-lg">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-rose-300">Call Notice</h4>
                <p className="text-xs text-rose-200/90 mt-0.5 leading-relaxed">{errorMessage}</p>
              </div>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="p-1 hover:bg-rose-500/20 rounded-lg text-rose-400 transition"
              title="Dismiss error"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Central Voice Action Section: ONE Big Mic Button */}
        <section className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 sm:p-8 flex flex-col items-center justify-center text-center relative overflow-hidden backdrop-blur-sm">
          {/* Ambient Glow */}
          <div
            className={`absolute inset-0 transition-opacity duration-700 pointer-events-none ${
              callState === 'connected'
                ? isAshaSpeaking
                  ? 'bg-gradient-to-b from-teal-500/10 via-transparent to-transparent opacity-100'
                  : 'bg-gradient-to-b from-emerald-500/5 via-transparent to-transparent opacity-100'
                : 'opacity-0'
            }`}
          />

          {/* Big Mic Button */}
          <div className="relative mb-5 flex items-center justify-center">
            {/* Pulsing Ripple Rings during active call */}
            {callState === 'connected' && (
              <>
                <div
                  className={`absolute w-44 h-44 rounded-full border transition-all duration-300 ${
                    isAshaSpeaking
                      ? 'border-teal-500/40 scale-110 animate-ping opacity-30'
                      : isUserSpeaking
                      ? 'border-sky-500/40 scale-110 animate-ping opacity-30'
                      : 'border-emerald-500/20 scale-100 opacity-20'
                  }`}
                />
                <div
                  className={`absolute w-36 h-36 rounded-full transition-all duration-300 ${
                    isAshaSpeaking
                      ? 'bg-teal-500/15 animate-pulse'
                      : isUserSpeaking
                      ? 'bg-sky-500/15 animate-pulse'
                      : 'bg-emerald-500/10'
                  }`}
                />
              </>
            )}

            {/* Connecting Spinner Ring */}
            {callState === 'connecting' && (
              <div className="absolute w-32 h-32 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
            )}

            {/* The Main Tap Button */}
            <button
              onClick={handleToggleCall}
              aria-label={callState === 'idle' ? 'Start call with Asha' : 'Hang up call'}
              className={`relative z-10 w-28 h-28 sm:w-32 sm:h-32 rounded-full flex flex-col items-center justify-center shadow-2xl transition-all duration-300 active:scale-95 focus:outline-none focus:ring-4 ${
                callState === 'idle'
                  ? 'bg-gradient-to-tr from-teal-600 via-teal-500 to-emerald-400 hover:from-teal-500 hover:to-emerald-300 text-slate-950 shadow-teal-500/25 focus:ring-teal-400/40'
                  : callState === 'connecting'
                  ? 'bg-slate-800 text-amber-300 border border-amber-400/40 shadow-amber-500/10 focus:ring-amber-400/40'
                  : 'bg-gradient-to-tr from-rose-600 to-red-500 hover:from-rose-500 hover:to-red-400 text-white shadow-rose-500/30 focus:ring-rose-400/40'
              }`}
            >
              {callState === 'idle' ? (
                <>
                  <Mic className="w-10 h-10 sm:w-12 sm:h-12" />
                  <span className="text-[11px] font-bold uppercase tracking-wider mt-1">Tap to Call</span>
                </>
              ) : callState === 'connecting' ? (
                <>
                  <PhoneCall className="w-9 h-9 sm:w-10 sm:h-10 animate-bounce" />
                  <span className="text-[11px] font-bold uppercase tracking-wider mt-1">Connecting</span>
                </>
              ) : (
                <>
                  <PhoneOff className="w-9 h-9 sm:w-10 sm:h-10" />
                  <span className="text-[11px] font-bold uppercase tracking-wider mt-1">Hang Up</span>
                </>
              )}
            </button>
          </div>

          {/* Voice State Information */}
          <div className="flex flex-col items-center gap-1.5 z-10">
            {callState === 'idle' && (
              <>
                <h3 className="text-base sm:text-lg font-semibold text-slate-100">
                  Speak with Asha, Clinic Receptionist
                </h3>
                <p className="text-xs sm:text-sm text-slate-400 max-w-md">
                  Tap the button to call. Asha will answer immediately to help you schedule an appointment.
                </p>
              </>
            )}

            {callState === 'connecting' && (
              <>
                <h3 className="text-base sm:text-lg font-semibold text-amber-300">
                  Connecting to Sunrise Clinic...
                </h3>
                <p className="text-xs sm:text-sm text-slate-400">
                  Opening real-time voice line. Asha speaks first.
                </p>
              </>
            )}

            {callState === 'connected' && (
              <>
                <div className="flex items-center gap-2">
                  {isAshaSpeaking ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-teal-500/20 text-teal-300 text-xs font-medium border border-teal-500/30">
                      <Volume2 className="w-3.5 h-3.5 animate-pulse" />
                      Asha is speaking...
                    </span>
                  ) : isUserSpeaking ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-sky-500/20 text-sky-300 text-xs font-medium border border-sky-500/30">
                      <Mic className="w-3.5 h-3.5 animate-pulse" />
                      Listening to you...
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800 text-slate-300 text-xs font-medium border border-slate-700">
                      Line open • You can speak or interrupt anytime
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1">Tap the red button anytime to end the call.</p>
              </>
            )}
          </div>
        </section>

        {/* Booking Confirmation Card (Appears after booking confirmed) */}
        {booking && (
          <section className="bg-gradient-to-br from-teal-950/40 via-slate-900/90 to-slate-900 border border-teal-500/40 rounded-2xl p-5 sm:p-6 shadow-xl shadow-teal-500/5 relative overflow-hidden transition-all">
            <div className="flex items-start justify-between gap-4 border-b border-teal-500/20 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-teal-500/20 border border-teal-500/40 flex items-center justify-center text-teal-300">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-white">Booking Confirmation</h3>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-300 border border-teal-500/30">
                      Demo Confirmed
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Your appointment has been recorded at Sunrise Clinic
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopyBooking}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 border border-slate-700 transition"
                  title="Copy details"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-teal-400" />
                      <span className="text-teal-300">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Reference ID Highlight */}
            <div className="mt-4 p-3.5 rounded-xl bg-teal-950/50 border border-teal-500/30 flex items-center justify-between">
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-teal-300">
                  Booking Reference ID
                </span>
                <p className="text-lg font-mono font-bold text-white tracking-wider">
                  {booking.referenceId}
                </p>
              </div>
              <ShieldCheck className="w-6 h-6 text-teal-400 opacity-80" />
            </div>

            {/* Details Grid: Name, Phone, Day, Date, Time, Reason */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mt-4 text-xs">
              <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800 flex items-start gap-2.5">
                <User className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-slate-400 block font-medium">Patient Name</span>
                  <span className="text-slate-100 font-semibold text-sm">{booking.name || '—'}</span>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800 flex items-start gap-2.5">
                <Phone className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-slate-400 block font-medium">Phone Number</span>
                  <span className="text-slate-100 font-semibold text-sm">{booking.phone || '—'}</span>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800 flex items-start gap-2.5">
                <Calendar className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-slate-400 block font-medium">Day & Date</span>
                  <span className="text-slate-100 font-semibold text-sm">
                    {booking.day ? `${booking.day}, ` : ''}{booking.date || '—'}
                  </span>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800 flex items-start gap-2.5">
                <Clock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-slate-400 block font-medium">Appointment Time</span>
                  <span className="text-slate-100 font-semibold text-sm">{booking.time || '—'}</span>
                </div>
              </div>

              <div className="sm:col-span-2 p-3 rounded-lg bg-slate-800/40 border border-slate-800 flex items-start gap-2.5">
                <FileText className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-slate-400 block font-medium">Reason for Visit</span>
                  <span className="text-slate-100 font-medium text-sm leading-relaxed">
                    {booking.reason || '—'}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center gap-2 text-[11px] text-slate-400">
              <Info className="w-3.5 h-3.5 text-teal-400 shrink-0" />
              <span>Made-up demo data • For demonstration purposes only</span>
            </div>
          </section>
        )}

        {/* Live Transcript Panel */}
        <section className="bg-slate-900/50 border border-slate-800/80 rounded-2xl flex flex-col flex-1 min-h-[300px] overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/80">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-teal-400" />
              <h2 className="text-sm font-semibold text-slate-200">Live Transcript</h2>
            </div>
            {transcripts.length > 0 && (
              <span className="text-[11px] text-slate-500 font-mono">
                {transcripts.length} message{transcripts.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          <div
            ref={chatScrollRef}
            className="flex-1 p-4 sm:p-5 overflow-y-auto space-y-4 max-h-[420px]"
          >
            {transcripts.length === 0 ? (
              <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center p-6 text-slate-500">
                <div className="w-12 h-12 rounded-full bg-slate-800/80 flex items-center justify-center mb-3 text-slate-400">
                  <Mic className="w-5 h-5" />
                </div>
                <p className="text-sm font-medium text-slate-400">No conversation yet</p>
                <p className="text-xs text-slate-500 max-w-xs mt-1">
                  Tap the microphone above to start the call. Asha will answer right away.
                </p>
              </div>
            ) : (
              transcripts.map((item) => (
                <div
                  key={item.id}
                  className={`flex flex-col ${
                    item.role === 'asha' ? 'items-start' : 'items-end'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1 px-1">
                    <span
                      className={`text-[11px] font-semibold ${
                        item.role === 'asha' ? 'text-teal-400' : 'text-slate-400'
                      }`}
                    >
                      {item.role === 'asha' ? 'Asha (Receptionist)' : 'Caller (You)'}
                    </span>
                    <span className="text-[10px] text-slate-500">{item.timestamp}</span>
                  </div>

                  <div
                    className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-xs sm:text-sm leading-relaxed shadow-sm ${
                      item.role === 'asha'
                        ? 'bg-slate-800/90 text-slate-100 rounded-tl-sm border border-slate-700/60'
                        : 'bg-teal-600/90 text-white rounded-tr-sm border border-teal-500/40'
                    }`}
                  >
                    {item.text}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Footer info note */}
        <footer className="text-center text-[11px] text-slate-500 pb-2">
          Sunrise Clinic Demo Receptionist • Powered by Gemini Live API (Native Audio) • Voice Kore
        </footer>
      </main>
    </div>
  );
}
