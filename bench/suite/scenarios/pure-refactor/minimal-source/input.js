'use strict';
// messyFunction: parses a CSV-like record string into a structured object.
// Format: "key:value;key:value;..." with special handling for tags (comma list),
// age (integer), and active (boolean). Known messy — do not modify this file.

function messyFunction(s) {
  if (!s || typeof s !== 'string') {
    return null;
  }
  var result = {};
  result['name'] = null;
  result['age'] = NaN;
  result['tags'] = [];
  result['active'] = false;
  var parts = s.split(';');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (part.indexOf(':') === -1) {
      continue;
    }
    var colonIdx = part.indexOf(':');
    var k = part.substring(0, colonIdx);
    var v = part.substring(colonIdx + 1);
    if (k === 'name') {
      if (v !== undefined && v !== null && v !== '') {
        result['name'] = v;
      } else {
        result['name'] = null;
      }
    } else {
      if (k === 'age') {
        if (v !== undefined && v !== '') {
          var parsed = parseInt(v, 10);
          if (!isNaN(parsed)) {
            result['age'] = parsed;
          } else {
            result['age'] = NaN;
          }
        } else {
          result['age'] = NaN;
        }
      } else {
        if (k === 'tags') {
          if (v !== undefined && v !== null && v.trim() !== '') {
            var tagList = v.split(',');
            var trimmed = [];
            for (var j = 0; j < tagList.length; j++) {
              var t = tagList[j].trim();
              if (t !== '') {
                trimmed.push(t);
              }
            }
            result['tags'] = trimmed;
          } else {
            result['tags'] = [];
          }
        } else {
          if (k === 'active') {
            if (v === 'true') {
              result['active'] = true;
            } else {
              result['active'] = false;
            }
          }
        }
      }
    }
  }
  return result;
}

module.exports = { messyFunction };
