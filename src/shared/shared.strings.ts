// Strings of the shared modules (pdfAnnotations, pdfLibrary, hubTabs).
import { messages } from './i18n';

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const S = messages({
  ko: {
    // Annotation labels (conflict dialog)
    labelText: '텍스트',
    labelHighlight: '형광펜',
    labelImage: '이미지',
    labelPen: '펜',
    labelNote: '메모',
    labelUnderline: '밑줄',
    labelStrikeOut: '취소선',
    labelSquiggly: '물결 밑줄',
    labelSquare: '사각형',
    labelCircle: '원',
    labelLine: '선',
    labelPolygon: '다각형',
    labelPolyLine: '꺾은선',
    labelCaret: '삽입 표시',
    labelFileAttachment: '첨부 파일',
    labelSound: '소리',
    labelRedact: '가림',
    labelAnnotation: '주석',
    pageNumber: (n: number) => `${n}쪽`,
    // Relative time
    justNow: '방금',
    minutesAgo: (n: number) => `${n}분 전`,
    hoursAgo: (n: number) => `${n}시간 전`,
    daysAgo: (n: number) => `${n}일 전`,
    dateThisYear: (month: number, day: number) => `${month}월 ${day}일`,
    dateOtherYear: (year: number, month: number, day: number) => `${year}. ${month}. ${day}.`,
    // arXiv version badge
    latestVersion: '최신',
    // Display name of the default project (the stored name stays '기본')
    defaultProjectName: '기본',
  },
  en: {
    labelText: 'Text',
    labelHighlight: 'Highlight',
    labelImage: 'Image',
    labelPen: 'Pen',
    labelNote: 'Note',
    labelUnderline: 'Underline',
    labelStrikeOut: 'Strikethrough',
    labelSquiggly: 'Squiggly underline',
    labelSquare: 'Rectangle',
    labelCircle: 'Circle',
    labelLine: 'Line',
    labelPolygon: 'Polygon',
    labelPolyLine: 'Polyline',
    labelCaret: 'Insert mark',
    labelFileAttachment: 'File attachment',
    labelSound: 'Sound',
    labelRedact: 'Redaction',
    labelAnnotation: 'Annotation',
    pageNumber: (n: number) => `p. ${n}`,
    justNow: 'just now',
    minutesAgo: (n: number) => `${n} min ago`,
    hoursAgo: (n: number) => `${n} h ago`,
    daysAgo: (n: number) => `${n} ${n === 1 ? 'day' : 'days'} ago`,
    dateThisYear: (month: number, day: number) => `${EN_MONTHS[month - 1]} ${day}`,
    dateOtherYear: (year: number, month: number, day: number) => `${EN_MONTHS[month - 1]} ${day}, ${year}`,
    latestVersion: 'latest',
    defaultProjectName: 'Default',
  },
});
