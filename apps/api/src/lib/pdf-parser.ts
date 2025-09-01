import koffi, { KoffiFunction } from "koffi";
import { join } from "path";
import { stat } from "fs/promises";
import { platform } from "os";
import { PDF_PARSER_PATH } from "../natives";

// TODO: add a timeout to the Rust parser

export type PDFMetadata = {
  numPages: number;
  title?: string;
};

class RustPDFParser {
  private static instance: RustPDFParser;
  private _getPDFMetadata: KoffiFunction;

  private constructor() {
    const lib = koffi.load(PDF_PARSER_PATH);
    this._getPDFMetadata = lib.func("get_pdf_metadata", "string", ["string"]);
  }

  public static async isParserAvailable(): Promise<boolean> {
    if (RustPDFParser.instance) {
      return true;
    }

    try {
      await stat(PDF_PARSER_PATH);
      RustPDFParser.instance = new RustPDFParser();
      return true;
    } catch (_) {
      return false;
    }
  }

  public static async getInstance(): Promise<RustPDFParser> {
    if (!RustPDFParser.instance) {
      try {
        await stat(PDF_PARSER_PATH);
      } catch (_) {
        throw Error("Rust pdf-parser shared library not found");
      }
      RustPDFParser.instance = new RustPDFParser();
    }
    return RustPDFParser.instance;
  }

  public async getPDFMetadata(path: string): Promise<PDFMetadata> {
    return new Promise<PDFMetadata>((resolve, reject) => {
      this._getPDFMetadata.async(path, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          if (res.startsWith("RUSTFC:ERROR:")) {
            reject(new Error(res.replace("RUSTFC:ERROR:", "")));
          } else {
            try {
              const metadata = JSON.parse(res) as PDFMetadata;
              resolve(metadata);
            } catch (e) {
              reject(new Error("Failed to parse PDF metadata."));
            }
          }
        }
      });
    });
  }
}

export async function getPDFMetadata(path: string): Promise<PDFMetadata> {
  const converter = await RustPDFParser.getInstance();
  return await converter.getPDFMetadata(path);
}
