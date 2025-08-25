// components/ExportPDF.js
import React, { useRef } from 'react';
import { useReactToPrint } from 'react-to-print';
import ReactMarkdown from 'react-markdown';

const ExportPDF = ({ result }) => {
  const componentRef = useRef();

  const handlePrint = useReactToPrint({
    content: () => componentRef.current,
    documentTitle: 'PixelProof Visual Bug Report',
  });

  return (
    <div className="mt-4">
     <button
  onClick={handlePrint}
  className="inline-flex items-center justify-center h-12 px-6 rounded-xl bg-[#6c2bd9] text-white font-semibold shadow-md hover:brightness-95 active:brightness-90 focus:outline-none focus:ring-2 focus:ring-[#6c2bd9]/40 transition"
>
  Export as PDF
</button>
      <div ref={componentRef} className="hidden print:block text-black mt-4">
        <h2 className="text-xl font-bold mb-2">Visual Bug Report</h2>
        <div className="prose max-w-none">
          <ReactMarkdown>{result}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
};

export default ExportPDF;
