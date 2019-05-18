import PDFArray from 'src/core/objects/PDFArray';
import PDFBool from 'src/core/objects/PDFBool';
import PDFDict from 'src/core/objects/PDFDict';
import PDFHexString from 'src/core/objects/PDFHexString';
import PDFName from 'src/core/objects/PDFName';
import PDFNull from 'src/core/objects/PDFNull';
import PDFNumber from 'src/core/objects/PDFNumber';
import PDFObject from 'src/core/objects/PDFObject';
import PDFRawStream from 'src/core/objects/PDFRawStream';
import PDFRef from 'src/core/objects/PDFRef';
import PDFStream from 'src/core/objects/PDFStream';
import PDFString from 'src/core/objects/PDFString';
import BaseParser from 'src/core/parser/BaseParser';
import PDFContext from 'src/core/PDFContext';
import CharCodes from 'src/core/syntax/CharCodes';
import { DelimiterChars } from 'src/core/syntax/Delimiters';
import { Keywords } from 'src/core/syntax/Keywords';
import { DigitChars, NumericChars } from 'src/core/syntax/Numeric';
import { WhitespaceChars } from 'src/core/syntax/Whitespace';
import { charFromCode } from 'src/utils';

const { Newline, CarriageReturn } = CharCodes;

// TODO: Skip comments!
// TODO: Throw error if eof is reached before finishing object parse...
class PDFObjectParser extends BaseParser {
  static forBytes = (pdfBytes: Uint8Array, context: PDFContext) =>
    new PDFObjectParser(pdfBytes, context);

  protected readonly context: PDFContext;

  constructor(pdfBytes: Uint8Array, context: PDFContext) {
    super(pdfBytes);
    this.context = context;
  }

  // TODO: Is it possible to reduce duplicate parsing for ref lookaheads?
  // TODO: Maybe throw parsing error
  parseObject(): PDFObject {
    this.skipWhitespaceAndComments();

    if (this.matchKeyword(Keywords.true)) return PDFBool.True;
    if (this.matchKeyword(Keywords.false)) return PDFBool.False;
    if (this.matchKeyword(Keywords.null)) return PDFNull;

    const byte = this.bytes.peek();

    if (
      byte === CharCodes.LessThan &&
      this.bytes.peekAhead(1) === CharCodes.LessThan
    ) {
      return this.parseDictOrStream();
    }
    if (byte === CharCodes.LessThan) return this.parseHexString();
    if (byte === CharCodes.LeftParen) return this.parseString();
    if (byte === CharCodes.ForwardSlash) return this.parseName();
    if (byte === CharCodes.LeftSquareBracket) return this.parseArray();
    if (NumericChars.includes(byte)) return this.parseNumberOrRef();

    throw new Error('FIX ME!' + JSON.stringify(this.bytes.position()));
  }

  protected parseNumberOrRef(): PDFNumber | PDFRef {
    const firstNum = this.parseRawNumber();
    this.skipWhitespaceAndComments();

    const lookaheadStart = this.bytes.offset();
    if (DigitChars.includes(this.bytes.peek())) {
      const secondNum = this.parseRawNumber();
      this.skipWhitespaceAndComments();
      if (this.bytes.peek() === CharCodes.R) {
        this.bytes.next();
        return PDFRef.of(firstNum, secondNum);
      }
    }

    this.bytes.moveTo(lookaheadStart);
    return PDFNumber.of(firstNum);
  }

  // TODO: Maybe update PDFHexString.of() logic to remove whitespace and validate input?
  protected parseHexString(): PDFHexString {
    this.bytes.next(); // Move past the leading '<'

    let value = '';

    while (!this.bytes.done() && this.bytes.peek() !== CharCodes.GreaterThan) {
      value += charFromCode(this.bytes.next());
    }

    // TODO: Assert presence of '>' here, throw error if not present
    this.bytes.next(); // Move past the ending '>'

    return PDFHexString.of(value);
  }

  protected parseString(): PDFString {
    let nestingLvl = 0;
    let isEscaped = false;
    let value = '';

    while (!this.bytes.done()) {
      const byte = this.bytes.next();
      value += charFromCode(byte);

      // Check for unescaped parenthesis
      if (!isEscaped) {
        if (byte === CharCodes.LeftParen) nestingLvl += 1;
        if (byte === CharCodes.RightParen) nestingLvl -= 1;
      }

      // Track whether current character is being escaped or not
      if (byte === CharCodes.BackSlash) {
        isEscaped = !isEscaped;
      } else if (isEscaped) {
        isEscaped = false;
      }

      // Once (if) the unescaped parenthesis balance out, return their contents
      if (nestingLvl === 0) {
        // Remove the outer parens so they aren't part of the contents
        return PDFString.of(value.substring(1, value.length - 1));
      }
    }

    throw new Error('FIX ME!');
  }

  // TODO: Compare performance of string concatenation to charFromCode(...bytes)
  // TODO: Maybe preallocate small Uint8Array if can use charFromCode?
  protected parseName(): PDFName {
    this.bytes.next(); // Skip the leading '/'

    let name = '';
    while (!this.bytes.done()) {
      const byte = this.bytes.peek();
      if (
        byte < CharCodes.ExclamationPoint ||
        byte > CharCodes.Tilde ||
        WhitespaceChars.includes(byte) ||
        DelimiterChars.includes(byte)
      ) {
        break;
      }
      name += charFromCode(byte);
      this.bytes.next();
    }

    return PDFName.of(name);
  }

  protected parseArray(): PDFArray {
    this.bytes.next(); // Move past the leading '['
    this.skipWhitespaceAndComments();

    const pdfArray = PDFArray.withContext(this.context);
    while (this.bytes.peek() !== CharCodes.RightSquareBracket) {
      const element = this.parseObject();
      pdfArray.push(element);
      this.skipWhitespaceAndComments();
    }
    this.bytes.next();
    return pdfArray;
  }

  protected parseDict(): PDFDict {
    this.bytes.assertNext(CharCodes.LessThan);
    this.bytes.assertNext(CharCodes.LessThan);

    const pdfDict = PDFDict.withContext(this.context);

    while (
      !this.bytes.done() &&
      this.bytes.peek() !== CharCodes.GreaterThan &&
      this.bytes.peekAhead(1) !== CharCodes.GreaterThan
    ) {
      this.skipWhitespaceAndComments();
      const key = this.parseName();
      const value = this.parseObject();
      pdfDict.set(key, value);
      this.skipWhitespaceAndComments();
    }

    this.skipWhitespaceAndComments();
    this.bytes.assertNext(CharCodes.GreaterThan);
    this.bytes.assertNext(CharCodes.GreaterThan);

    return pdfDict;
  }

  protected parseDictOrStream(): PDFDict | PDFStream {
    const dict = this.parseDict();

    this.skipWhitespaceAndComments();
    if (!this.matchKeyword(Keywords.stream)) return dict;

    // Move past the EOL marker following `stream` (\r\n or \r or \n)
    const byte = this.bytes.peek();
    if (byte === Newline) this.bytes.next();
    if (byte === CarriageReturn) {
      this.bytes.next();
      if (this.bytes.peek() === Newline) this.bytes.next();
    }

    const start = this.bytes.offset();

    // TODO: Try to use dict's `Length` entry, but use this as backup...

    // Move to end of stream, while handling nested streams
    let nestingLvl = 1;
    while (!this.bytes.done()) {
      if (this.matchKeyword(Keywords.stream)) nestingLvl += 1;
      if (this.matchKeyword(Keywords.endstream)) nestingLvl -= 1;
      if (nestingLvl === 0) break;
      this.bytes.next();
    }

    let end = this.bytes.offset() - Keywords.endstream.length;

    // Move back our `end` marker to account for the EOL marker that should
    // be in front of `endstream` (\r\n or \r or \n)
    const twoBack = this.bytes.peekAt(end - 2);
    const oneBack = this.bytes.peekAt(end - 1);
    if (twoBack === CarriageReturn && oneBack === Newline) end -= 2;
    else if (oneBack === CarriageReturn) end -= 1;
    else if (oneBack === Newline) end -= 1;

    const contents = this.bytes.slice(start, end);

    return PDFRawStream.of(dict, contents);
  }
}

export default PDFObjectParser;
