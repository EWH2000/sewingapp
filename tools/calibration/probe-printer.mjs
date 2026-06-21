import ipppkg from "ipp";
const ipp = ipppkg.default || ipppkg;
const P = process.env.PRN || "192.168.8.198";

const paths = ["/ipp/print", "/ipp/printer", "/ipp", "/"];
function getAttrs(path){
  return new Promise((resolve)=>{
    const printer = ipp.Printer(`http://${P}:631${path}`);
    printer.execute("Get-Printer-Attributes",
      { "operation-attributes-tag": { "requested-attributes": [
          "printer-make-and-model","printer-state","printer-state-reasons",
          "ipp-versions-supported","document-format-supported","document-format-default",
          "print-scaling-supported","print-scaling-default",
          "media-supported","media-default","media-ready",
          "sides-supported","printer-resolution-supported","printer-resolution-default",
          "printer-uri-supported","uri-security-supported","uri-authentication-supported",
          "color-supported","pdf-versions-supported","print-color-mode-supported",
          "orientation-requested-supported","copies-supported","output-bin-supported" ] } },
      (err,res)=>resolve({path,err:err&&String(err),res}));
  });
}
for(const path of paths){
  const {err,res}=await getAttrs(path);
  if(err){ console.log(`[${path}] ERR: ${err}`); continue; }
  const a = res["printer-attributes-tag"]||{};
  console.log(`\n===== Get-Printer-Attributes OK via ${path} (statusCode=${res.statusCode}) =====`);
  const show=(k)=>{ if(a[k]!==undefined) console.log(`  ${k}:`, JSON.stringify(a[k])); };
  ["printer-make-and-model","printer-state","printer-state-reasons","ipp-versions-supported",
   "document-format-default","document-format-supported",
   "print-scaling-default","print-scaling-supported",
   "media-default","media-ready","media-supported",
   "print-color-mode-supported","color-supported","sides-supported",
   "printer-resolution-default","printer-uri-supported","copies-supported"].forEach(show);
  // explicit yes/no on the two make-or-break capabilities
  const fmts = [].concat(a["document-format-supported"]||[]);
  const scal = [].concat(a["print-scaling-supported"]||[]);
  const med  = [].concat(a["media-supported"]||[]);
  console.log("\n  >>> accepts application/pdf directly? ", fmts.includes("application/pdf") ? "YES" : "NO  ("+fmts.join(", ")+")");
  console.log("  >>> supports print-scaling=none?       ", scal.includes("none") ? "YES" : (scal.length? "NO ("+scal.join(",")+")":"attr not advertised"));
  console.log("  >>> has a US-Letter media name?         ", med.find(m=>/letter/i.test(m)) || "none letter-like found");
  break;
}
