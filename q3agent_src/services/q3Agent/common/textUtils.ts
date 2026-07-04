/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Safely replaces text with literal strings, avoiding ECMAScript GetSubstitution issues.
 * Escapes $ characters to prevent template interpretation ($&, $1, etc.).
 */
export function safeLiteralReplace(
	str: string,
	oldString: string,
	newString: string,
	replaceAll: boolean = false,
): string {
	if (oldString === '' || !str.includes(oldString)) {
		return str;
	}

	if (!newString.includes('$')) {
		return replaceAll
			? str.replaceAll(oldString, newString)
			: str.replace(oldString, newString);
	}

	const escapedNewString = newString.replaceAll('$', '$$$$');
	return replaceAll
		? str.replaceAll(oldString, escapedNewString)
		: str.replace(oldString, escapedNewString);
}
