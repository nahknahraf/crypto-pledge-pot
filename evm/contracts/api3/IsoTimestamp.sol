// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {DateTimeLib} from "solady/utils/DateTimeLib.sol";

/// @title Reads ISO 8601 dates and date-times as Unix timestamps
/// @notice Reads the forms that APIs write, such as "2024-11-05T12:00:00Z" and "2024-11-05" from Polymarket, and
/// "2026-10-23 10:55+02:00" from AeroDataBox. No common Solidity library reads these, so this one does the reading.
/// @dev Solady's DateTimeLib does the calendar arithmetic, and OpenZeppelin's Strings reads the digits.
library IsoTimestamp {
    error InvalidTimestamp(string text);

    /// @notice Reads an ISO 8601 date or date-time as a Unix timestamp in seconds
    /// @dev A date-time has T or a space before the time, optional seconds with an optional fraction, which is cut off,
    /// and Z or an offset such as +02:00, +0200 or +02. So "2026-10-23 10:55+02:00" reads as 1792745700. A date-time
    /// without Z or an offset reverts, because it is the local time of a place that the text does not name. A date
    /// alone, such as "2024-11-05", reads as its midnight in UTC. A time before 1970 in UTC reverts, because a Unix
    /// timestamp in a uint256 starts there, and so does "1970-01-01T00:30+01:00". Anything else that is not one of these
    /// forms reverts with InvalidTimestamp too.
    function parse(string memory text) internal pure returns (uint256) {
        bytes memory characters = bytes(text);
        uint256 midnight = parseDate(characters);
        if (characters.length == 10) return midnight;

        if (!isCharacterAt(characters, 10, "T") && !isCharacterAt(characters, 10, " ")) revert InvalidTimestamp(text);
        (uint256 secondsIntoDay, uint256 offsetPosition) = parseTime(characters);
        (bool isAheadOfUtc, uint256 offset) = parseOffset(characters, offsetPosition);
        uint256 localTimestamp = midnight + secondsIntoDay;
        if (!isAheadOfUtc) return localTimestamp + offset;
        if (offset > localTimestamp) revert InvalidTimestamp(text);
        return localTimestamp - offset;
    }

    /// @dev Reads the yyyy-mm-dd at the start of `text` as the timestamp of its midnight in UTC.
    function parseDate(bytes memory text) private pure returns (uint256) {
        if (!isCharacterAt(text, 4, "-") || !isCharacterAt(text, 7, "-")) revert InvalidTimestamp(string(text));
        uint256 year = parseDigits(text, 0, 4);
        uint256 month = parseDigits(text, 5, 2);
        uint256 day = parseDigits(text, 8, 2);
        if (!DateTimeLib.isSupportedDate(year, month, day)) revert InvalidTimestamp(string(text));
        return DateTimeLib.dateToTimestamp(year, month, day);
    }

    /// @dev Reads the hh:mm that follows the date, with optional :ss and fraction, as seconds into the day. Returns the
    /// position after it.
    function parseTime(bytes memory text) private pure returns (uint256 secondsIntoDay, uint256 end) {
        if (!isCharacterAt(text, 13, ":")) revert InvalidTimestamp(string(text));
        uint256 hour = parseDigits(text, 11, 2);
        uint256 minute = parseDigits(text, 14, 2);
        bool hasSeconds = isCharacterAt(text, 16, ":");
        uint256 second = hasSeconds ? parseDigits(text, 17, 2) : 0;
        // A Unix timestamp has no leap seconds, so 23:59:60 reverts.
        if (hour > 23 || minute > 59 || second > 59) revert InvalidTimestamp(string(text));
        secondsIntoDay = hour * 1 hours + minute * 1 minutes + second;
        end = hasSeconds ? skipFraction(text, 19) : 16;
    }

    function skipFraction(bytes memory text, uint256 position) private pure returns (uint256 end) {
        if (!isCharacterAt(text, position, ".")) return position;
        end = position + 1;
        while (end < text.length && isDigit(text[end])) end++;
        if (end == position + 1) revert InvalidTimestamp(string(text));
    }

    /// @dev Reads the offset from UTC that runs from `position` to the end of `text`: Z, or +hh, +hhmm or +hh:mm, or
    /// the same with -.
    function parseOffset(bytes memory text, uint256 position) private pure returns (bool isAheadOfUtc, uint256 offset) {
        uint256 offsetLength = text.length - position;
        if (offsetLength == 1 && text[position] == "Z") return (true, 0);
        if (offsetLength != 3 && offsetLength != 5 && offsetLength != 6) revert InvalidTimestamp(string(text));
        isAheadOfUtc = text[position] == "+";
        if (!isAheadOfUtc && text[position] != "-") revert InvalidTimestamp(string(text));
        if (offsetLength == 6 && text[position + 3] != ":") revert InvalidTimestamp(string(text));
        uint256 offsetHours = parseDigits(text, position + 1, 2);
        uint256 offsetMinutes = offsetLength == 3 ? 0 : parseDigits(text, text.length - 2, 2);
        if (offsetHours > 23 || offsetMinutes > 59) revert InvalidTimestamp(string(text));
        offset = offsetHours * 1 hours + offsetMinutes * 1 minutes;
    }

    function parseDigits(bytes memory text, uint256 start, uint256 count) private pure returns (uint256) {
        (bool isNumber, uint256 value) = Strings.tryParseUint(string(text), start, start + count);
        if (!isNumber) revert InvalidTimestamp(string(text));
        return value;
    }

    function isCharacterAt(bytes memory text, uint256 position, bytes1 character) private pure returns (bool) {
        return position < text.length && text[position] == character;
    }

    function isDigit(bytes1 character) private pure returns (bool) {
        return character >= "0" && character <= "9";
    }
}
