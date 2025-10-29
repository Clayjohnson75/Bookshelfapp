import React from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet, ScrollView } from 'react-native';

interface PendingScanCardProps {
  scan: {
    id: string;
    uri: string;
    books: any[];
    rejectedBooks: any[];
    timestamp: number;
  };
  onApproveAll: () => void;
  onApproveSelected: (bookIds: string[]) => void;
  onReject: () => void;
}

export const PendingScanCard: React.FC<PendingScanCardProps> = ({
  scan,
  onApproveAll,
  onApproveSelected,
  onReject,
}) => {
  const [selectedBooks, setSelectedBooks] = React.useState<Set<string>>(new Set());
  
  const toggleBook = (bookTitle: string) => {
    const newSelected = new Set(selectedBooks);
    if (newSelected.has(bookTitle)) {
      newSelected.delete(bookTitle);
    } else {
      newSelected.add(bookTitle);
    }
    setSelectedBooks(newSelected);
  };

  const handleApproveSelected = () => {
    onApproveSelected(Array.from(selectedBooks));
  };

  return (
    <View style={styles.card}>
      <Image source={{ uri: scan.uri }} style={styles.image} resizeMode="cover" />
      <Text style={styles.count}>{scan.books.length} books found</Text>
      
      <ScrollView style={styles.booksList}>
        {scan.books.map((book, index) => (
          <TouchableOpacity
            key={index}
            style={[
              styles.bookItem,
              selectedBooks.has(book.title) && styles.bookItemSelected,
            ]}
            onPress={() => toggleBook(book.title)}
          >
            <Text style={styles.bookTitle}>{book.title}</Text>
            <Text style={styles.bookAuthor}>{book.author}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, styles.approveAllButton]}
          onPress={onApproveAll}
        >
          <Text style={styles.buttonText}>Approve All</Text>
        </TouchableOpacity>
        {selectedBooks.size > 0 && (
          <TouchableOpacity
            style={[styles.button, styles.approveSelectedButton]}
            onPress={handleApproveSelected}
          >
            <Text style={styles.buttonText}>Approve Selected ({selectedBooks.size})</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.button, styles.rejectButton]}
          onPress={onReject}
        >
          <Text style={styles.buttonText}>Reject</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 15,
    margin: 10,
    padding: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  image: {
    width: '100%',
    height: 200,
    borderRadius: 10,
    marginBottom: 10,
  },
  count: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 10,
  },
  booksList: {
    maxHeight: 200,
  },
  bookItem: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  bookItemSelected: {
    backgroundColor: '#e8f5e9',
  },
  bookTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  bookAuthor: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 15,
    gap: 10,
  },
  button: {
    flex: 1,
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  approveAllButton: {
    backgroundColor: '#27ae60',
  },
  approveSelectedButton: {
    backgroundColor: '#007AFF',
  },
  rejectButton: {
    backgroundColor: '#e74c3c',
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});

