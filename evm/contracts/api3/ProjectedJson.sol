// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {JSONParserLib} from "solady/utils/JSONParserLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {IsoTimestamp} from "./IsoTimestamp.sol";

/// @title Reads the fields of a projected response, and escapes keys for the projection's pointers
/// @notice A response projection cuts a response down to a flat object, such as
/// {"price":2443.95,"updatedAt":1792403240691}. This library reads a top-level field of that object by its name.
/// Solady's JSONParserLib parses the JSON and finds the field, and this library adds reading decimal numbers with a
/// fixed number of decimal places. IsoTimestamp reads times, and OpenZeppelin's Strings reads hex. escapePointerToken
/// writes a key into a pointer of the projection, for a contract that builds a request hash.
/// @dev Verify the signature before you read the data. The signature is what makes sure that the data is the JSON that
/// the Airnode produced, with the fields that your projection asked for. Invalid JSON reverts with
/// JSONParserLib.ParsingFailed.
library ProjectedJson {
    using JSONParserLib for JSONParserLib.Item;

    error FieldNotFound(string key);
    error UnexpectedValue(string key);

    /// @notice Reads a number that is not negative, with `decimals` decimal places
    /// @dev Digits after `decimals` decimal places are cut off, so 2443.959 with 2 decimals reads as 244395. The
    /// Airnode signs each number as the API wrote it, so an integer of any size, such as an amount in wei, keeps every
    /// digit. The number can also be written as a string, such as "0.0005", as the Polymarket CLOB and Hyperliquid
    /// write theirs. The string has to hold a number as JSON writes it, so "1." and "" revert.
    /// @param json The signed data
    /// @param key Field name, as written in the JSON
    /// @param decimals Number of decimal places in the result, so 18 reads 2443.95 as 2443950000000000000000
    function readUint(bytes memory json, string memory key, uint8 decimals) internal pure returns (uint256) {
        return decodeUint(findValue(json, key), key, decimals);
    }

    /// @notice Reads a number that can be negative, with `decimals` decimal places
    /// @dev Digits after `decimals` decimal places are cut off toward zero, so -1.239 with 2 decimals reads as -123. The
    /// number can also be written as a string, such as "-0.0000125".
    function readInt(bytes memory json, string memory key, uint8 decimals) internal pure returns (int256) {
        return decodeInt(findValue(json, key), key, decimals);
    }

    function readBool(bytes memory json, string memory key) internal pure returns (bool) {
        JSONParserLib.Item memory item = findValue(json, key);
        if (!item.isBoolean()) revert UnexpectedValue(key);
        return LibString.eq(item.value(), "true");
    }

    /// @notice Reads a string, with its escape sequences decoded, so the value "say \"hi\"" reads as say "hi"
    function readString(bytes memory json, string memory key) internal pure returns (string memory) {
        return decodeString(findValue(json, key), key);
    }

    /// @notice Whether a field is null, such as the winner of a match that has not ended
    /// @dev The other functions revert on null, so check this first for a field that can be null.
    function isNull(bytes memory json, string memory key) internal pure returns (bool) {
        return findValue(json, key).isNull();
    }

    /// @notice Reads an ISO 8601 date or date-time, such as "2024-11-05T12:00:00Z", as a Unix timestamp in seconds
    /// @dev IsoTimestamp.parse reads it, and says which forms it takes. A text that it does not read reverts with
    /// IsoTimestamp.InvalidTimestamp.
    function readTimestamp(bytes memory json, string memory key) internal pure returns (uint256) {
        return IsoTimestamp.parse(readString(json, key));
    }

    /// @notice Reads an address written as a hex string, such as "0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0"
    /// @dev OpenZeppelin's Strings.parseAddress reads it, so anything but 40 hex digits, with or without 0x, reverts with
    /// Strings.StringsInvalidAddressFormat. The EIP-55 checksum is not checked, because the signature already covers
    /// every character.
    function readAddress(bytes memory json, string memory key) internal pure returns (address) {
        return Strings.parseAddress(readString(json, key));
    }

    /// @notice Reads 32 bytes written as a hex string, such as a Polymarket condition id
    /// @dev The string has to be 64 hex digits, with or without 0x, because leading zeros are part of the bytes, and a
    /// shorter string could have lost zeros at either end. Any other length reverts with UnexpectedValue, and a
    /// character that is not hex with Strings.StringsInvalidChar. For an API that drops the leading zeros of an id,
    /// bytes32(readHexUint(json, key)) puts them back in front.
    function readBytes32(bytes memory json, string memory key) internal pure returns (bytes32) {
        string memory text = readString(json, key);
        if (countHexDigits(text) != 64) revert UnexpectedValue(key);
        return bytes32(Strings.parseHexUint(text));
    }

    /// @notice Reads a number written as a hex string, such as the balance "0x1bc16d674ec80000" from Ethereum JSON-RPC
    /// @dev OpenZeppelin's Strings.parseHexUint reads it, so any number of digits reads, with or without 0x. A string
    /// without digits reverts with UnexpectedValue, and a character that is not hex with Strings.StringsInvalidChar.
    function readHexUint(bytes memory json, string memory key) internal pure returns (uint256) {
        string memory text = readString(json, key);
        // Strings.parseHexUint reads "" and "0x" as 0.
        if (countHexDigits(text) == 0) revert UnexpectedValue(key);
        return Strings.parseHexUint(text);
    }

    /// @notice Reads item `index` of an array as a number that is not negative, with `decimals` decimal places, as
    /// readUint reads a field
    /// @dev For an array that the API writes as a string, such as Polymarket's "outcomePrices":"[\"1\", \"0\"]", read
    /// the string first, because no pointer reaches inside a string: readUint(bytes(readString(data, "outcomePrices")),
    /// 0, 18). The errors name the item by its index, such as "0".
    function readUint(bytes memory json, uint256 index, uint8 decimals) internal pure returns (uint256) {
        return decodeUint(findItem(json, index), LibString.toString(index), decimals);
    }

    /// @notice Reads item `index` of an array as a string, as readString reads a field
    function readString(bytes memory json, uint256 index) internal pure returns (string memory) {
        return decodeString(findItem(json, index), LibString.toString(index));
    }

    /// @notice Escapes a key for a JSON Pointer of a projection, writing "~" as "~0" and "/" as "~1", so ETH/USD
    /// becomes ETH~1USD
    /// @dev "~" is replaced first, so the "~" of a "~1" that this writes is not escaped again. The result is not
    /// escaped for JSON, so escape it with LibString.escapeJSON before it goes into a request.
    function escapePointerToken(string memory key) internal pure returns (string memory) {
        return LibString.replace(LibString.replace(key, "~", "~0"), "/", "~1");
    }

    function findValue(bytes memory json, string memory key) private pure returns (JSONParserLib.Item memory item) {
        // JSONParserLib matches the key as it is written in the JSON, with its quotes.
        item = JSONParserLib.parse(string(json)).at(string.concat('"', key, '"'));
        if (item.isUndefined()) revert FieldNotFound(key);
    }

    function findItem(bytes memory json, uint256 index) private pure returns (JSONParserLib.Item memory item) {
        item = JSONParserLib.parse(string(json)).at(index);
        if (item.isUndefined()) revert FieldNotFound(LibString.toString(index));
    }

    function decodeUint(JSONParserLib.Item memory item, string memory key, uint8 decimals)
        private
        pure
        returns (uint256)
    {
        (bool isNegative, uint256 magnitude) = decodeNumber(item, key, decimals);
        if (isNegative) revert UnexpectedValue(key);
        return magnitude;
    }

    function decodeInt(JSONParserLib.Item memory item, string memory key, uint8 decimals)
        private
        pure
        returns (int256)
    {
        (bool isNegative, uint256 magnitude) = decodeNumber(item, key, decimals);
        int256 value = SafeCast.toInt256(magnitude);
        return isNegative ? -value : value;
    }

    /// @dev Reads a number written as -?digits(.digits)?, or a string that holds one. Exponent notation such as 1.2e-7
    /// reverts with JSONParserLib.ParsingFailed.
    function decodeNumber(JSONParserLib.Item memory item, string memory key, uint8 decimals)
        private
        pure
        returns (bool isNegative, uint256 magnitude)
    {
        // The string is parsed as JSON on its own, so it follows the same rules as a number without quotes.
        JSONParserLib.Item memory numberItem =
            item.isString() ? JSONParserLib.parse(JSONParserLib.decodeString(item.value())) : item;
        if (!numberItem.isNumber()) revert UnexpectedValue(key);

        string memory number = numberItem.value();
        bool hasMinusSign = bytes(number)[0] == "-";
        string memory unsignedNumber = hasMinusSign ? LibString.slice(number, 1) : number;
        uint256 pointPosition = LibString.indexOf(unsignedNumber, ".");
        uint256 fractionDigitCount =
            pointPosition == LibString.NOT_FOUND ? 0 : bytes(unsignedNumber).length - pointPosition - 1;
        uint256 digits = JSONParserLib.parseUint(LibString.replace(unsignedNumber, ".", ""));
        // -0 and -0.0 are zero, but -0.001 stays negative when the decimals cut it to zero.
        isNegative = hasMinusSign && digits != 0;
        magnitude = scaleToDecimals(digits, fractionDigitCount, decimals);
    }

    function decodeString(JSONParserLib.Item memory item, string memory key) private pure returns (string memory) {
        if (!item.isString()) revert UnexpectedValue(key);
        return JSONParserLib.decodeString(item.value());
    }

    function countHexDigits(string memory text) private pure returns (uint256) {
        return bytes(text).length - (LibString.startsWith(text, "0x") ? 2 : 0);
    }

    /// @dev Turns `digits`, of which the last `fractionDigitCount` are after the decimal point, into a value with
    /// `decimals` decimal places.
    function scaleToDecimals(uint256 digits, uint256 fractionDigitCount, uint8 decimals)
        private
        pure
        returns (uint256)
    {
        if (fractionDigitCount <= decimals) return digits * 10 ** (decimals - fractionDigitCount);
        uint256 cutDigitCount = fractionDigitCount - decimals;
        // A uint256 has at most 78 digits, so cutting more leaves nothing.
        return cutDigitCount >= 78 ? 0 : digits / 10 ** cutDigitCount;
    }
}
