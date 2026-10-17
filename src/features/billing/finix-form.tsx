"use client";

import Script from "next/script";
import { useRef, useState } from "react";
import { finixSubscribe } from "./actions";

type TokenResponse = { data?: { id?: string } };
type FinixCardForm = {
  submit(
    environment: string,
    applicationId: string,
    cb: (err: unknown, res: TokenResponse) => void,
  ): void;
};
declare global {
  interface Window {
    Finix?: {
      CardTokenForm(
        elementId: string,
        options: { submitLabel?: string; onSubmit?: () => void },
      ): FinixCardForm;
    };
  }
}

/**
 * Finix.js v1 hosted card fields → `PI_…` instrument id → hidden input →
 * `finixSubscribe`. Card data never touches this app. `onSubmit` renders
 * Finix's own submit button inside the iframe container.
 */
export function FinixForm({
  applicationId,
  environment,
  planId,
}: {
  applicationId: string;
  environment: string;
  planId: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const piRef = useRef<HTMLInputElement>(null);
  const finixRef = useRef<FinixCardForm | null>(null);
  const [error, setError] = useState<string | null>(null);

  const init = () => {
    if (finixRef.current || !window.Finix) return;
    const finixForm = window.Finix.CardTokenForm("finix-form", {
      submitLabel: "Subscribe",
      onSubmit: () =>
        finixForm.submit(environment, applicationId, (err, res) => {
          const id = res?.data?.id;
          if (err || !id) {
            setError("Card tokenization failed — check the details and retry.");
            return;
          }
          if (piRef.current) piRef.current.value = id;
          formRef.current?.requestSubmit();
        }),
    });
    finixRef.current = finixForm;
  };

  return (
    <>
      <Script src="https://js.finix.com/v/1/finix.js" onLoad={init} strategy="afterInteractive" />
      <div id="finix-form" />
      {error && <p className="error">{error}</p>}
      <form ref={formRef} action={finixSubscribe}>
        <input type="hidden" name="planId" value={planId} />
        <input ref={piRef} type="hidden" name="paymentInstrumentId" />
      </form>
    </>
  );
}
